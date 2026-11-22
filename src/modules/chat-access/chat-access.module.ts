import { Module } from '@nestjs/common';
import { CassandraModule } from '@common/cassandra/cassandra.module';
import { ChatAdmissionRepository } from '@modules/message-writer/admission/chat-admission.repository';
import { ChatAccessService } from './chat-access.service';

@Module({
  imports: [CassandraModule],
  providers: [ChatAdmissionRepository, ChatAccessService],
  exports: [ChatAccessService, ChatAdmissionRepository],
})
export class ChatAccessModule {}
