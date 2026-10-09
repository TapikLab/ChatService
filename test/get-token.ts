import * as crypto from 'crypto';
import axios from 'axios';

const AUTH_SERVICE_URL =
  process.env.AUTH_SERVICE_URL || 'http://localhost:3000';

const testUser = {
  email: '1@ethereal.email',
  password: '12345678',
};

async function getAuthToken() {
  try {
    // 1. Генерация пары ключей Ed25519 (32 байта raw)
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

    const rawPublicKeyBytes = publicKey
      .export({ type: 'spki', format: 'der' })
      .subarray(-32);
    const publicKeyBase64 = rawPublicKeyBytes.toString('base64');

    const rawPrivateKeyBytes = privateKey
      .export({ type: 'pkcs8', format: 'der' })
      .subarray(-32);
    const privateKeyBase64 = rawPrivateKeyBytes.toString('base64');

    console.log('--- Сгенерированные ключи Ed25519 ---');
    console.log('Public Key (Base64, 32 bytes):', publicKeyBase64);
    console.log('Private Key (Base64, 32 bytes):', privateKeyBase64);
    console.log('------------------------------------\n');

    // 2. Вход (передаем ТОЛЬКО email и password)
    console.log(`1. Логин на ${AUTH_SERVICE_URL}/auth/login ...`);
    const loginRes = await axios.post(`${AUTH_SERVICE_URL}/auth/login`, {
      email: testUser.email,
      password: testUser.password,
    });

    const token =
      loginRes.data.accessToken || loginRes.data.token || loginRes.data;
    console.log('Токен успешно получен!\n');

    // 3. Регистрация публичного ключа устройства
    console.log('2. Регистрация устройства с publicKey...');
    const deviceRes = await axios.post(
      `${AUTH_SERVICE_URL}/auth/devices`, // Или /auth/devices / /devices/register
      { publicKey: publicKeyBase64 },
      { headers: { Authorization: `Bearer ${token}` } },
    );

    console.log('\n=== Устройство успешно зарегистрировано ===');
    console.log(
      'Device ID:',
      deviceRes.data.id || deviceRes.data.deviceId || deviceRes.data,
    );
    console.log('\n=== JWT Token ===');
    console.log(token);

    return { token, publicKeyBase64, privateKeyBase64 };
  } catch (error: any) {
    console.error('Ошибка:', error.response?.data || error.message);
  }
}

getAuthToken();
