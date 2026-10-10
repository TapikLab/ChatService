# Checkpoint-клиент (Node.js, без UI и новых зависимостей)

Все команды ниже выполняются из `/Users/karapetyan_tik/Projects/Tapik/ChatService`.

## Проверка

```bash
./node_modules/.bin/tsc --project test/checkpoint/tsconfig.json
./node_modules/.bin/tsc --noEmit --incremental false
./node_modules/.bin/jest --config test/checkpoint/jest.config.json --runInBand
./node_modules/.bin/jest --runInBand --runTestsByPath src/modules/messages/checkpoint-delivery.spec.ts
```

Тесты используют настоящий Ed25519 и временные локальные журналы. HTTP, Cassandra,
RabbitMQ и Redis заменены тестовыми реализациями: это не проверка развёрнутой системы.

## Инициализация устройства

Нужны работающие AuthService/ChatService, существующий чат и два его участника.
Серверные изменения эпика 0.3 и таблица `chat_chain_claims` должны быть применены.
`AUTH_URL` включает `/auth`, а `CHAT_URL` — адрес ChatService без `/chats`.

В терминале первого участника:

```bash
export AUTH_URL='http://localhost:3000/auth'
export CHAT_URL='http://localhost:3002'
export AUTH_TOKEN='ACCESS_TOKEN_ALICE'
export USER_ID='UUID_ALICE'
export CHAT_ID='UUID_CHAT'

./node_modules/.bin/ts-node --project test/checkpoint/tsconfig.json \
  test/checkpoint/run.ts init /Users/karapetyan_tik/.tapik-checkpoint-alice
```

Во втором терминале повторить с токеном/UUID второго участника и каталогом
`/Users/karapetyan_tik/.tapik-checkpoint-bob`. UUID должны соответствовать реальным данным.

`init` регистрирует новое устройство, сохраняет `device.pem` и `config.json`,
выводит только публичный объект `{ userId, deviceId, publicKey }`.
При сетевой ошибке регистрации повторный `init` использует сохранённый ключ.
Готовый `config.json` не перезаписывается.

Обменяйтесь публичными объектами по независимому доверенному каналу. В массив
`pins` файла `config.json` каждого клиента добавьте объект другого участника.
Для старой истории нужны также ключи всех устройств, подписавших её сообщения.
Автоматической загрузки доверенных ключей с сервера нет.

## Запуск

```bash
export CHAT_URL='http://localhost:3002'
export AUTH_TOKEN='ACCESS_TOKEN_ALICE'

./node_modules/.bin/ts-node --project test/checkpoint/tsconfig.json \
  test/checkpoint/run.ts run /Users/karapetyan_tik/.tapik-checkpoint-alice
```

Второй участник запускает ту же команду со своим каталогом и токеном.
Каждая непустая строка stdin отправляется как обычное подписанное сообщение.
Завершение — Ctrl+C. После обновления JWT перезапустите клиент с новым `AUTH_TOKEN`.

- История опрашивается каждые 5 секунд, realtime-checkpoint принимается сразу.
- Checkpoint публикуется после 50 проверенных обычных сообщений либо через
  5 минут после первого неопубликованного обычного сообщения. При простое не публикуется.
- Checkpoint тоже входит в chat/device chain, но не увеличивает счётчик обычных сообщений.
- Очередь и сохранённый outbox обеспечивают повтор неизменного запроса после ошибки.
- При расхождении stdout содержит `CHAT_HISTORY_DIVERGENCE` и два подписанных
  свидетельства (`left`, `right`). Новая отправка блокируется, доказательства сохраняются.
- Диагностика идёт в stderr, сообщения об отправке и расхождениях — в stdout.

## Локальное состояние

`state.jsonl` — дописываемый журнал с fsync, проверенными позициями, checkpoint и outbox.
`state.jsonl.lock` запрещает второй процесс с тем же журналом. После аварии прочитайте
PID в lock-файле и удалите **только lock-файл**, убедившись, что прежний процесс завершён.
Незавершённая последняя запись журнала восстанавливается автоматически. Повреждённая
законченная запись вызывает остановку.

Не удаляйте журнал и не используйте устройство для отправки из другого клиента.
Не копируйте один ключ/журнал на два одновременно работающих клиента. Приватные ключи
и состояние держите вне Git. Новое устройство требует новой регистрации.

Обмен подписанный, пока без E2E. Полностью изолирующий участников сервер может
скрывать доставку свидетельств. Переписанное локальное состояние и компрометация
закреплённого приватного ключа не входят в гарантии этого клиента.
