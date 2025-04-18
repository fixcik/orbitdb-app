import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { identify, identifyPush } from '@libp2p/identify';
import { createHelia, HeliaLibp2p } from 'helia';
import { GossipSub, gossipsub } from '@chainsafe/libp2p-gossipsub';
import { tcp } from '@libp2p/tcp';
import { yamux } from '@chainsafe/libp2p-yamux';
import { mplex } from '@libp2p/mplex';
import { httpGatewayRouting } from '@helia/routers';
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery';
import {
  BaseDatabase,
  createOrbitDB,
  IPFSAccessController,
  OpenDatabaseOptions,
  OrbitDB,
} from '@orbitdb/core';
import { ConfigService } from '../config/config.service.js';
import { Libp2p } from 'libp2p';
import {
  circuitRelayTransport,
  circuitRelayServer,
} from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { autoNAT } from '@libp2p/autonat';
import { Multiaddr } from '@multiformats/multiaddr';
import { ping } from '@libp2p/ping';
import { bootstrap } from '@libp2p/bootstrap';
import { uPnPNAT } from '@libp2p/upnp-nat';
import { LevelBlockstore } from 'blockstore-level';
import { preSharedKey } from '@libp2p/pnet';
import { PeerId, DialOptions } from '@libp2p/interface';
import { setTimeout } from 'node:timers/promises';
import { webSockets } from '@libp2p/websockets';
import { kadDHT } from '@libp2p/kad-dht';
import { webRTC } from '@libp2p/webrtc';

@Injectable()
export class OrbitDBService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrbitDBService.name);
  private orbitdb: OrbitDB;
  private helia: HeliaLibp2p<Libp2p<Record<string, unknown>>>;
  private database: BaseDatabase;
  private pubsub: GossipSub;
  private isReady = false;

  constructor(private configService: ConfigService) {}

  async onModuleInit() {
    await this.connect();
    this.isReady = true;
  }

  async onModuleDestroy() {
    await this.disconnect();
    this.isReady = false;
  }

  async waitForReady() {
    while (!this.isReady) {
      await setTimeout(100);
    }
  }

  async connect() {
    try {
      const id = process.env.ID;

      const blockstore = new LevelBlockstore(
        `${this.configService.orbitdbDirectory}/block-store`,
      );

      this.helia = await createHelia({
        // datastore,
        blockstore,
        routers: [httpGatewayRouting()],
        libp2p: {
          addresses: {
            listen: [
              `/ip4/${this.configService.ipfsHost}/tcp/${this.configService.ipfsTcpPort}`,
              `/ip4/${this.configService.ipfsHost}/tcp/${this.configService.ipfsWsPort}/ws`,
              '/p2p-circuit',
              '/webrtc',
            ],
          },
          transports: [circuitRelayTransport(), webSockets(), tcp(), webRTC()],
          streamMuxers: [yamux(), mplex()],
          peerDiscovery: [
            pubsubPeerDiscovery({
              interval: 1000,
            }),
            ...(this.configService.bootstrapNode
              ? [
                  bootstrap({
                    list: [this.configService.bootstrapNode],
                  }),
                ]
              : []),
          ],
          connectionProtector: preSharedKey({
            psk: this.configService.swarmKey,
          }),
          connectionManager: {
            // reconnectRetries: Infinity,
          },
          services: {
            autoNAT: autoNAT(),
            dcutr: dcutr(),
            relay: circuitRelayServer(),
            pubsub: gossipsub({
              canRelayMessage: true,
              allowPublishToZeroTopicPeers: true,
            }),
            identify: identify(),
            identifyPush: identifyPush(),
            ping: ping(),
            dht: kadDHT({
              clientMode: false,
            }),
            upnp: uPnPNAT(),
          },
        },
      });

      this.pubsub = this.helia.libp2p.services.pubsub as GossipSub;

      this.helia.libp2p.addEventListener('peer:discovery', (evt) => {
        this.logger.log('Found peer: ', evt.detail.id.toString());
        void this.connectTo(evt.detail.id);
      });

      const addresses = this.helia.libp2p.getMultiaddrs();

      this.orbitdb = await createOrbitDB({
        ipfs: this.helia,
        directory: this.configService.orbitdbDirectory,
        id,
      });

      this.orbitdb.ipfs.libp2p.addEventListener('peer:connect', (peerId) => {
        this.logger.log(`peer:connect`, peerId.detail.toString());
      });
      this.orbitdb.ipfs.libp2p.addEventListener('peer:disconnect', (peerId) => {
        this.logger.log(`peer:disconnect`, peerId.detail);
      });

      this.logger.log('OrbitDB successfully connected', {
        addresses,
      });

      setInterval(() => {
        const peers = this.helia.libp2p.getPeers();

        console.log(
          `PeerID: ${this.orbitdb.ipfs.libp2p.peerId.toString()}, peers: ${JSON.stringify(peers)}`,
        );
      }, 2000);
    } catch (err) {
      const error = err as Error;
      this.logger.error(
        `Error connecting to OrbitDB: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async connectTo(
    peer: PeerId | Multiaddr | Multiaddr[],
    options?: DialOptions,
  ) {
    const maxRetries = 20;
    let retries = 0;

    while (retries < maxRetries) {
      try {
        await this.helia.libp2p.dial(peer, options);
        this.logger.log(
          `Successfully connected to peer after ${retries} retries`,
        );
        return;
      } catch (err) {
        const error = err as Error;
        retries++;

        if (retries >= maxRetries) {
          this.logger.error(
            `Failed to connect to peer after ${maxRetries} attempts: ${error.message}`,
            error.stack,
          );
          return;
        }

        this.logger.warn(
          `Error connecting to peer (attempt ${retries}/${maxRetries}): ${error.message}`,
        );

        await setTimeout(1000 * Math.min(retries, 5));
      }
    }
  }

  async disconnect() {
    try {
      if (this.orbitdb) {
        await this.orbitdb.stop();
        this.logger.log('OrbitDB connection closed');
      }

      if (this.helia) {
        await this.helia.stop();
        this.logger.log('Helia node stopped');
      }

      if (this.database) {
        await this.database.close();
        this.logger.log('Database closed');
      }
    } catch (err) {
      const error = err as Error;
      this.logger.error(
        `Error during OrbitDB disconnect: ${error.message}`,
        error.stack,
      );
    }
  }

  async openDatabase(
    name: string,
    options?: OpenDatabaseOptions,
  ): Promise<BaseDatabase> {
    await this.waitForReady();
    if (!this.orbitdb) {
      throw new Error('OrbitDB not connected');
    }
    try {
      const database = await this.orbitdb.open(name, {
        type: 'documents',
        AccessController: IPFSAccessController(),

        sync: true,
        ...options,
      });

      this.logger.log(
        `Database ${name}: '${database.address}'  opened successfully`,
      );
      return database;
    } catch (err) {
      const error = err as Error;
      this.logger.error(
        `Failed to open database '${name}': ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async closeDatabase(database: BaseDatabase) {
    if (database) {
      await database.close();
      this.logger.log(`Database closed`);
    }
  }
}
