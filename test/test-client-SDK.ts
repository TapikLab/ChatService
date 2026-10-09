import { generateKeyPairSync, sign, createHash, randomUUID } from 'node:crypto';
import { verifyChainIntegrity, ChainEntry } from './chain-verify';
import axios from 'axios';

const BASE_AUTH_URL = process.env.AUTH_URL || 'http://localhost:3000/auth';
const BASE_CHAT_URL = process.env.CHAT_URL || 'http://localhost:3002/chats';

const EMAIL = process.env.TEST_EMAIL || '1@ethereal.email';
const PASSWORD = process.env.TEST_PASSWORD || '12345678';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

interface Attachment {
  mediaId: string;
  type: string;
}

function createSignedMessagePayload(params: {
  chatId: string;
  senderDeviceId: string;
  seq: number;
  prevHash: string;
  content: string;
  attachments?: Attachment[];
  privateKey: any;
}) {
  const {
    chatId,
    senderDeviceId,
    seq,
    prevHash,
    content,
    attachments = [],
    privateKey,
  } = params;

  const attachmentsStr = attachments
    .map((a) => `${a.mediaId}:${a.type}`)
    .join(',');
  const contentHash = sha256Hex((content ?? '') + '\n' + attachmentsStr);

  const signingPayload = [
    'tapik.msg.v1',
    chatId,
    senderDeviceId,
    String(seq),
    prevHash,
    contentHash,
  ].join('\n');

  const signatureBytes = sign(
    null,
    Buffer.from(signingPayload, 'utf8'),
    privateKey,
  );

  return {
    payload: {
      chatId,
      senderDeviceId,
      seq,
      prevHash,
      content,
      attachments,
      signature: signatureBytes.toString('base64'),
    },
    messageHash: sha256Hex(signingPayload),
  };
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyRaw = publicKey.export({ format: 'der', type: 'spki' });
const publicKeyBytes = publicKeyRaw.subarray(publicKeyRaw.length - 32);
const publicKeyBase64 = publicKeyBytes.toString('base64');

async function runTests() {
  let authToken = '';

  console.log(`=== Step 0: Вход в систему (${EMAIL}) ===`);
  try {
    const loginRes = await axios.post(`${BASE_AUTH_URL}/login`, {
      email: EMAIL,
      password: PASSWORD,
    });

    const token =
      loginRes.data.accessToken || loginRes.data.token || loginRes.data.jwt;

    if (!token) {
      throw new Error(
        'Сервер вернул 200, но поле с токеном не найдено в ответе: ' +
          JSON.stringify(loginRes.data),
      );
    }

    authToken = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    console.log('Успешный вход! Токен получен.');
  } catch (err: any) {
    console.error(
      'Ошибка при входе в систему:',
      err.response?.data || err.message,
    );
    return;
  }

  const httpConfig = {
    headers: {
      Authorization: authToken,
      'Content-Type': 'application/json',
    },
  };

  console.log('\n=== Step 1: Регистрация устройства ===');
  let senderDeviceId: string;

  try {
    const regRes1 = await axios.post(
      `${BASE_AUTH_URL}/devices`,
      { publicKey: publicKeyBase64 },
      httpConfig,
    );
    senderDeviceId = regRes1.data.deviceId;
    console.log('Registered Device ID:', senderDeviceId);

    const regRes2 = await axios.post(
      `${BASE_AUTH_URL}/devices`,
      { publicKey: publicKeyBase64 },
      httpConfig,
    );
    console.log('Re-registration Device ID:', regRes2.data.deviceId);
    console.assert(
      senderDeviceId === regRes2.data.deviceId,
      'Device IDs do not match!',
    );
  } catch (err: any) {
    console.error(
      'Step 1 Failed (Device registration):',
      err.response?.data || err.message,
    );
    return;
  }

  // Свежий chatId для чистого прогона
  const chatId = '9bc4d32b-d153-4727-8f6b-ec10f2ef6c8e';
  console.log(`\n--- Используем новый chatId: ${chatId} ---`);

  console.log('\n=== Step 2: Отправка сообщения (seq = 1) ===');
  const seq1 = 1;
  const prevHash1 = '0'.repeat(64);

  const { payload: payloadStep2, messageHash: msgHash1 } =
    createSignedMessagePayload({
      chatId,
      senderDeviceId,
      seq: seq1,
      prevHash: prevHash1,
      content: 'Hello Tapik E2E!',
      privateKey,
    });

  let msgRes: any = null;
  let step2ChainHash = '';
  let step2MessageHash = msgHash1;

  try {
    msgRes = await axios.post(
      `${BASE_CHAT_URL}/messages`,
      payloadStep2,
      httpConfig,
    );
    step2ChainHash = msgRes.data.chainHash || msgHash1;
    step2MessageHash = msgRes.data.messageHash || msgHash1;
    console.log('Message 1 Status:', msgRes.status, msgRes.data);
  } catch (err: any) {
    console.error('Message 1 Failed:', err.response?.data || err.message);
  }

  console.log('\n=== Step 3: Проверка ретрая (Replay) ===');
  try {
    const replayRes = await axios.post(
      `${BASE_CHAT_URL}/messages`,
      payloadStep2,
      httpConfig,
    );
    console.log('Replay Response:', replayRes.data);
  } catch (err: any) {
    console.error('Replay Failed:', err.response?.data || err.message);
  }

  console.log('\n=== Step 4: Проверка SEQ_REUSED (409) ===');
  const { payload: payloadStep4 } = createSignedMessagePayload({
    chatId,
    senderDeviceId,
    seq: 1,
    prevHash: sha256Hex('different_prev_hash'),
    content: 'Hello duplicate seq content',
    privateKey,
  });

  try {
    const res409 = await axios.post(
      `${BASE_CHAT_URL}/messages`,
      payloadStep4,
      httpConfig,
    );
    console.log('SEQ_REUSED Test Unexpected Success:', res409.data);
  } catch (error: any) {
    console.log(
      'SEQ_REUSED Test Result:',
      error.response?.status,
      error.response?.data,
    );
  }

  console.log('\n=== Step 5: Проверка битой подписи (403) ===');
  try {
    await axios.post(
      `${BASE_CHAT_URL}/messages`,
      {
        ...payloadStep2,
        seq: 2,
        prevHash: step2MessageHash,
        signature: Buffer.alloc(64).toString('base64'),
      },
      httpConfig,
    );
  } catch (err: any) {
    console.log(
      'Bad Signature Test Result:',
      err.response?.status,
      err.response?.data,
    );
  }

  // ================= STEP 6: HASH-CHAIN ЧАТА И УСТРОЙСТВА =================
  console.log('\n=== Step 6: hash-chain чата ===');

  const { payload: payloadSeq2, messageHash: msgHash2 } =
    createSignedMessagePayload({
      chatId,
      senderDeviceId,
      seq: 2,
      prevHash: step2MessageHash,
      content: 'Second message',
      privateKey,
    });

  try {
    const r2 = await axios.post(
      `${BASE_CHAT_URL}/messages`,
      payloadSeq2,
      httpConfig,
    );
    console.log(
      'seq2 -> chatSeq:',
      r2.data.chatSeq,
      'replayed:',
      r2.data.replayed,
    );

    const prevHashForSeq3 = r2.data.messageHash || msgHash2;

    const { payload: payloadSeq3 } = createSignedMessagePayload({
      chatId,
      senderDeviceId,
      seq: 3,
      prevHash: prevHashForSeq3,
      content: 'Third message',
      privateKey,
    });

    const r3 = await axios.post(
      `${BASE_CHAT_URL}/messages`,
      payloadSeq3,
      httpConfig,
    );
    console.log(
      'seq3 -> chatSeq:',
      r3.data.chatSeq,
      'replayed:',
      r3.data.replayed,
    );

    // Ретрай seq2
    const r2Again = await axios.post(
      `${BASE_CHAT_URL}/messages`,
      payloadSeq2,
      httpConfig,
    );
    console.assert(
      r2Again.data.chatSeq === r2.data.chatSeq &&
        r2Again.data.replayed === true,
      'Replay seq2 изменил chatSeq!',
    );

    const chainRes = await axios.get(
      `${BASE_CHAT_URL}/${chatId}/chain?limit=100`,
      httpConfig,
    );
    const entries: ChainEntry[] = [...chainRes.data.entries].reverse();
    console.log('Chain entries (Step 6):', entries.length);
    console.log('Chain verdict (Step 6):', verifyChainIntegrity(entries));

    const tamperIndex = Math.floor(entries.length / 2);
    const tampered = entries.map((e, i) =>
      i === tamperIndex ? { ...e, messageHash: sha256Hex('forged') } : e,
    );
    console.log('Tampered verdict (Step 6):', verifyChainIntegrity(tampered));
  } catch (err: any) {
    console.error('Step 6 Failed:', err.response?.data || err.message);
  }

  // ================= STEP 7: ГОНКА РАЗНЫХ ОТПРАВИТЕЛЕЙ =================
  console.log('\n=== Step 7: параллельные отправки (CAS-цикл) ===');
  try {
    const PARALLEL = 5;
    const payloads: ReturnType<typeof createSignedMessagePayload>['payload'][] =
      [];

    // Регистрируем устройства последовательно до начала гонки отправок.
    for (let i = 0; i < PARALLEL; i++) {
      const keys = generateKeyPairSync('ed25519');
      const raw = keys.publicKey.export({ format: 'der', type: 'spki' });
      const pub = raw.subarray(raw.length - 32).toString('base64');

      const reg = await axios.post(
        `${BASE_AUTH_URL}/devices`,
        { publicKey: pub },
        httpConfig,
      );

      const { payload } = createSignedMessagePayload({
        chatId,
        senderDeviceId: reg.data.deviceId,
        seq: 1,
        prevHash: '0'.repeat(64),
        content: `parallel ${i}`,
        privateKey: keys.privateKey,
      });

      payloads.push(payload);
    }

    const results = await Promise.all(
      payloads.map((payload) =>
        axios.post(`${BASE_CHAT_URL}/messages`, payload, httpConfig),
      ),
    );

    const seqs = results
      .map((r) => r.data.chatSeq as number)
      .sort((a, b) => a - b);
    console.log('chatSeq параллельных сообщений:', seqs);
    console.assert(new Set(seqs).size === PARALLEL, 'Дубли chatSeq!');
    console.assert(
      seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1),
      'Дыры в chatSeq!',
    );

    const chainRes = await axios.get(
      `${BASE_CHAT_URL}/${chatId}/chain?limit=500`,
      httpConfig,
    );
    const entries: ChainEntry[] = [...chainRes.data.entries].reverse();
    console.log('Chain verdict после гонки:', verifyChainIntegrity(entries));
  } catch (err: any) {
    console.error('Step 7 Failed:', err.response?.data || err.message);
  }
}

runTests();
