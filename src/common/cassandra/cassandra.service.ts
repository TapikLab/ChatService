import {
  Injectable,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { auth, Client } from 'cassandra-driver';

@Injectable()
export class CassandraService implements OnModuleInit, OnApplicationShutdown {
  public client!: Client;
  private shutdownPromise?: Promise<void>;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    this.client = new Client({
      authProvider: new auth.PlainTextAuthProvider(
        this.config.getOrThrow<string>('SCYLLA_USERNAME'),
        this.config.getOrThrow<string>('SCYLLA_PASSWORD'),
      ),
      contactPoints: [this.config.getOrThrow<string>('SCYLLA_CONTACT_POINT')],
      localDataCenter: 'datacenter1',
      keyspace: this.config.getOrThrow<string>('SCYLLA_KEYSPACE'),
      protocolOptions: {
        port: this.config.get<number>('SCYLLA_PORT', 9042),
      },
    });

    await this.client.connect();
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.client) return;

    if (!this.shutdownPromise) this.shutdownPromise = this.client.shutdown();

    await this.shutdownPromise;
  }
}
