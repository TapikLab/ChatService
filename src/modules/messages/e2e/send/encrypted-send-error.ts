import { HttpException } from '@nestjs/common';

type SendErrorAction =
  | 'RETRY_SAME_REQUEST'
  | 'WAIT_PREVIOUS_SEND'
  | 'REFRESH_RECIPIENTS'
  | 'REFRESH_GROUP_CONTEXT'
  | 'DISTRIBUTE_GROUP_KEY'
  | 'STOP';

interface ErrorRule {
  readonly status: number;
  readonly action: SendErrorAction;
}

interface SendErrorBody {
  readonly statusCode: number;
  readonly code: string;
  readonly action: SendErrorAction;
}

const RULES: ReadonlyMap<string, ErrorRule> = new Map([
  [
    'GROUP_MEMBERSHIP_CHANGED',
    {
      status: 409,
      action: 'REFRESH_GROUP_CONTEXT',
    },
  ],
  [
    'GROUP_DEVICE_SET_CHANGED',
    {
      status: 409,
      action: 'REFRESH_GROUP_CONTEXT',
    },
  ],
  [
    'GROUP_KEY_ROTATION_REQUIRED',
    {
      status: 409,
      action: 'DISTRIBUTE_GROUP_KEY',
    },
  ],
  [
    'GROUP_KEY_NOT_REGISTERED',
    {
      status: 409,
      action: 'DISTRIBUTE_GROUP_KEY',
    },
  ],
  [
    'GROUP_DISTRIBUTION_ID_REUSED',
    {
      status: 409,
      action: 'STOP',
    },
  ],
  [
    'SEND_OPERATION_ALREADY_REGISTERED',
    {
      status: 409,
      action: 'STOP',
    },
  ],
  [
    'GROUP_ENVELOPE_REQUIRED',
    {
      status: 409,
      action: 'STOP',
    },
  ],
  [
    'PAIRWISE_ENVELOPE_REQUIRED',
    {
      status: 409,
      action: 'STOP',
    },
  ],
  [
    'GROUP_DISTRIBUTION_OUTCOME_UNKNOWN',
    {
      status: 503,
      action: 'RETRY_SAME_REQUEST',
    },
  ],
  [
    'NOT_A_CHAT_MEMBER',
    {
      status: 403,
      action: 'STOP',
    },
  ],
  [
    'DEVICE_NOT_ACTIVE',
    {
      status: 403,
      action: 'STOP',
    },
  ],
  [
    'INVALID_MESSAGE_SIGNATURE',
    {
      status: 403,
      action: 'STOP',
    },
  ],
  [
    'E2EE_RECIPIENTS_CHANGED',
    {
      status: 409,
      action: 'REFRESH_RECIPIENTS',
    },
  ],
  [
    'E2EE_DIRECTORY_NOT_READY',
    {
      status: 409,
      action: 'RETRY_SAME_REQUEST',
    },
  ],
  [
    'E2EE_RECIPIENT_LIMIT_EXCEEDED',
    {
      status: 409,
      action: 'STOP',
    },
  ],
  [
    'E2EE_CHAT_MEMBER_LIMIT_EXCEEDED',
    {
      status: 409,
      action: 'STOP',
    },
  ],
  [
    'PREVIOUS_SEND_NOT_COMMITTED',
    {
      status: 409,
      action: 'WAIT_PREVIOUS_SEND',
    },
  ],
  [
    'DEVICE_CHAIN_MISMATCH',
    {
      status: 409,
      action: 'STOP',
    },
  ],
  [
    'SEND_OPERATION_REUSED',
    {
      status: 409,
      action: 'STOP',
    },
  ],
  [
    'SEND_CANDIDATE_REUSED',
    {
      status: 409,
      action: 'STOP',
    },
  ],
  [
    'CHAT_COMMAND_ID_REUSED',
    {
      status: 409,
      action: 'STOP',
    },
  ],
  [
    'CHAT_STATE_CHANGED_RETRY_SAME_REQUEST',
    {
      status: 503,
      action: 'RETRY_SAME_REQUEST',
    },
  ],
  [
    'SEND_OPERATION_EXISTS_RETRY_SAME_REQUEST',
    {
      status: 503,
      action: 'RETRY_SAME_REQUEST',
    },
  ],
]);

function exception(
  status: number,
  code: string,
  action: SendErrorAction,
): HttpException {
  const body: SendErrorBody = {
    statusCode: status,
    code,
    action,
  };

  return new HttpException(body, status);
}

export function unknownSendOutcome(): HttpException {
  return exception(503, 'E2EE_SEND_OUTCOME_UNKNOWN', 'RETRY_SAME_REQUEST');
}

export function mapWriterSendError(
  status: number,
  value: unknown,
): HttpException {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const body = value as Record<string, unknown>;
    const message = body.message;

    if (
      body.statusCode === status &&
      typeof message === 'string' &&
      message.length <= 100
    ) {
      const rule = RULES.get(message);

      if (rule && rule.status === status) {
        return exception(status, message, rule.action);
      }
    }
  }

  return unknownSendOutcome();
}
