import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { auth, Client } from 'cassandra-driver';

@Injectable()
export class CassandraService implements OnModuleInit, OnModuleDestroy {
  public client!: Client;

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

  async onModuleDestroy() {
    await this.client.shutdown();
  }
}
