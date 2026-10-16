# Локальный запуск эпика 0.4

Миграция выполнена 2026-10-16 на локальной Scylla 5.4. Включены PasswordAuthenticator и CassandraAuthorizer. Колонка `messages.edit_of` добавлена без изменения старых сообщений. Перед миграцией создан snapshot `before_epic04_20261016` для `chat_alpha_messages` и `chat_alpha_reactions`.

## Роли

- `tapik_chat_v04`: SELECT на messages, chat_chain_log, chat_chain_claims и device_chain_state; SELECT/MODIFY на изменяемые таблицы чатов.
- `tapik_writer_v04`: SELECT/MODIFY на четыре защищённые таблицы; SELECT на chat_members.
- `tapik_reactions_v04`: SELECT/MODIFY только на message_reactions своего keyspace.
- `tapik_dba_v04`: отдельная административная роль. Секрет не передаётся приложениям.
- Стандартная роль `cassandra` отключена: LOGIN=false, SUPERUSER=false.

## Запуск

```bash
cd /Users/karapetyan_tik/Projects/Tapik/ChatService
./scripts/epic04-runtime.sh status
./scripts/epic04-runtime.sh start
```

Команды `stop` и `logs` относятся только к writer, ChatService и ReactionsService, не к Scylla.

Контейнеры имеют `restart: unless-stopped`:

- tapik-message-writer: HTTPS, опубликован только 127.0.0.1:3009.
- tapik-chat-service: HTTP 127.0.0.1:3002 и внутренний gRPC 127.0.0.1:5001.
- tapik-reactions-service: HTTP 127.0.0.1:3003.

Writer и ChatService работают в разных контейнерах без общего каталога проекта. Writer получает свой пароль, ChatService — только свою роль и токен append API. Контейнер ChatService монтирует только публичный TLS-сертификат, writer — сертификат и приватный TLS-ключ. Docker socket не монтируется. Файловые системы read-only, Linux capabilities сброшены. Общий каталог исходников/секретов в контейнеры не монтируется.

AuthService запускается на хосте отдельно, поскольку writer обращается к нему по gRPC 5004:

```bash
cd /Users/karapetyan_tik/Projects/Tapik/AuthService
TS_NODE_BASEURL=./dist/src node -r tsconfig-paths/register dist/src/main.js
```

В текущей сессии AuthService уже запущен. Не запускайте второй процесс на том же порту. MediaService и остальные сервисы продукта не относятся к этой миграции; для отправки вложений должен быть запущен существующий MediaService.

## Приватные настройки

`.local/epic04/` исключён из Git. Каталог содержит раздельные env-файлы контейнеров, локальный TLS-сертификат, приватный ключ и credentials.json с административным/сервисными паролями. Не коммитить, не отправлять этот каталог и не монтировать его целиком в контейнер ChatService. Не удалять credentials.json: стандартный логин cassandra уже отключён.

Локальные `.env` ChatService и ReactionsService обновлены собственными DB-ролями. Для запуска ChatService прямо на хосте потребуется задать `NODE_EXTRA_CA_CERTS` на абсолютный путь `.local/epic04/tls.crt` до запуска Node.js; основной проверенный запуск — контейнерный.

`.local/epic04/image/` — контекст собранного образа tapik-epic04-runtime:local. Он содержит скомпилированный код ChatService/ReactionsService и существующие lock-файлы; секретов в образе нет. После изменения исходников потребуется пересобрать соответствующий dist, обновить контекст образа и пересобрать образ перед перезапуском.

## Выполненная проверка

- ChatService: strict TypeScript, сборка Nest и 64 серверных теста.
- ReactionsService: strict TypeScript, сборка Nest и 12 серверных тестов.
- Живая Scylla: 35 проверок прав на автоматически созданных временных keyspace/ролях; временные ресурсы удалены после теста.
- Живая интеграция: 19 проверок входа, регистрации устройства, подписанной отправки, Socket.IO, точного retry, EDIT/DELETE с сохранением оригинала, checkpoint, истории/цепочки, неверной подписи, отзыва устройства и реального запрета UPDATE под ролью ChatService. Временный пользователь и чат удалены после теста.

Полный end-to-end тест внешних уведомлений, вложений и ИИ в эту проверку не входит. Клиентское приложение не изменялось.
