/**
 * Тест PWA-авторизации: выдача, проверка и отказ на подделке.
 *
 * Токен — единственный секрет, который живёт вне Telegram: приложение открыто
 * в браузере и с домашнего экрана, где подписи Telegram не существует. Поэтому
 * проверяется не только штатный путь, но и всё, чем можно попытаться токен
 * подделать: изменённый payload, подмена чужого userId, изменённая подпись,
 * истёкший срок и сломанный base64.
 *
 * Отказ здесь обязан быть null, а не исключением: неверный токен в заголовке
 * должен давать внятный 401, а не ронять API стектрейсом.
 *
 * Проверяется и конфигурация секрета: PWA обязана деградировать до «не настроена»,
 * а не ронять живого бота из-за отсутствующей переменной окружения.
 *
 * Запуск: npm run test:pwa-auth
 */

const GOOD_SECRET = 'a'.repeat(64);

process.env.PWA_AUTH_SECRET = GOOD_SECRET;

const {
  isPwaAuthConfigured,
  issuePwaToken,
  verifyPwaToken,
  hashToken,
  PwaAuthConfigError,
  PWA_TOKEN_TTL_MS,
} = await import('../src/utils/pwaAuth.ts');

/** Идентификатор человека: UUID, а не Telegram ID — так идентифицируется пользователь. */
const USER_ID = '3f8a1c2e-5b7d-4a91-8c3f-2d6e9b0a1f47';
const OTHER_USER_ID = '9e1d7a44-2c88-4b6f-91a5-7c0b3e5d8a26';

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Подставляет секрет на время проверки и возвращает функцию восстановления. */
function withSecret(value: string | undefined): () => void {
  const previous = process.env.PWA_AUTH_SECRET;
  if (value === undefined) delete process.env.PWA_AUTH_SECRET;
  else process.env.PWA_AUTH_SECRET = value;

  return () => {
    if (previous === undefined) delete process.env.PWA_AUTH_SECRET;
    else process.env.PWA_AUTH_SECRET = previous;
  };
}

/** Пересобирает токен с подменённой частью: base64url(часть) + '.' + хвост. */
function tamper(token: string, index: 0 | 1 | 2, replacement: string): string {
  const parts = token.split('.');
  parts[index] = Buffer.from(replacement, 'utf-8').toString('base64url');
  return parts.join('.');
}

console.log('\n=== PWA-авторизация: токен доступа ===\n');

console.log('— Конфигурация секрета —');

check('секрет задан — PWA настроена', isPwaAuthConfigured() === true);

{
  const restore = withSecret(undefined);
  check('секрет не задан — PWA не настроена, но не падает', isPwaAuthConfigured() === false);
  check('проверка токена без секрета даёт null, а не исключение', verifyPwaToken('x.y.z') === null);

  let threw = false;
  try {
    issuePwaToken(USER_ID);
  } catch (err: unknown) {
    threw = err instanceof PwaAuthConfigError;
  }
  check('выдача без секрета бросает PwaAuthConfigError', threw);
  restore();
}

{
  const restore = withSecret('короткий');
  check('секрет неверной длины — не настроена', isPwaAuthConfigured() === false);
  restore();
}

{
  // Строка ровно в 32 байта принимается: так же, как в utils/crypto.ts.
  const restore = withSecret('x'.repeat(32));
  check('секрет в 32 байта без hex принимается', isPwaAuthConfigured() === true);
  restore();
}

console.log('\n— Выдача токена —');

const issued = issuePwaToken(USER_ID);

check('токен состоит из трёх частей', issued.token.split('.').length === 3);
check('срок в будущем', issued.expiresAt > Date.now());
check(
  'срок = 90 дней по умолчанию',
  Math.abs(issued.expiresAt - (Date.now() + PWA_TOKEN_TTL_MS)) < 5000,
  `ttl=${PWA_TOKEN_TTL_MS}`,
);

{
  const short = issuePwaToken(USER_ID, 60_000);
  check('срок можно задать вручную', short.expiresAt < issued.expiresAt);
  check('короткий токен ещё жив', verifyPwaToken(short.token)?.userId === USER_ID);
}

{
  const empty = verifyPwaToken(issuePwaToken(USER_ID).token);
  check('в токене читается тот же userId', empty?.userId === USER_ID);
  check(
    'в токене лежит userId, а не Telegram ID',
    empty !== null && empty.userId !== String(757471228),
  );
}

check('токен не содержит userId открытым текстом', !issued.token.includes(USER_ID));
check('токен не содержит секрет', !issued.token.includes(GOOD_SECRET));

console.log('\n— Хэш токена для базы —');

const tokenHash = hashToken(issued.token);

check('хэш токена — 64 hex-символа', /^[0-9a-f]{64}$/.test(tokenHash));
check('хэш стабилен', hashToken(issued.token) === tokenHash);
check('хэш не содержит сам токен', !tokenHash.includes(issued.token));
// Токены, выданные в одну и ту же миллисекунду, совпадают побайтно — payload
// это userId плюс срок, а срок имеет миллисекундную точность. Поэтому
// различие проверяется на заведомо разных токенах, а не на двух вызовах подряд.
check(
  'разные токены дают разные хэши',
  hashToken(issuePwaToken(USER_ID, 60_000).token) !== hashToken(issuePwaToken(OTHER_USER_ID, 60_000).token),
);

console.log('\n— Подделка —');

check('верный токен проходит', verifyPwaToken(issued.token)?.userId === USER_ID);

check('пустой токен отклонён', verifyPwaToken('') === null);
check('не-строка отклонена', verifyPwaToken(null as unknown as string) === null);
check('мусор вместо токена отклонён', verifyPwaToken('не-токен') === null);
check('токен из двух частей отклонён', verifyPwaToken('abc.def') === null);
check('токен из четырёх частей отклонён', verifyPwaToken('a.b.c.d') === null);
check('пустые части отклонены', verifyPwaToken('..') === null);

{
  const stolen = issuePwaToken(OTHER_USER_ID);
  const swapped = tamper(issued.token, 0, OTHER_USER_ID);

  check('подмена userId в payload отклонена', verifyPwaToken(swapped) === null);
  check('чужой токен сам по себе валиден', verifyPwaToken(stolen.token)?.userId === OTHER_USER_ID);
}

{
  // Подпись портится ЗАМЕНОЙ ПЕРВОГО символа, а не последнего.
  //
  // Причина, из-за которой это пришлось уточнить: подпись — это base64url от 32
  // байт, то есть 43 символа, а значащих в последнем из них только два бита.
  // Node при разборе игнорирует «хвостовые» биты, поэтому подстановка другого
  // последнего символа нередко даёт ровно те же 32 байта — токен остаётся
  // подлинным, и проверка падает примерно в одном прогоне из двенадцати.
  // Первый символ кодирует шесть значащих бит, и его замена всегда меняет байты.
  const parts = issued.token.split('.');
  const signature = parts[2];
  const broken = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);

  check('изменённая подпись отклонена', verifyPwaToken(`${parts[0]}.${parts[1]}.${broken}`) === null);
}
{
  // Подпись берётся у токена с ЗАВЕДОМО другим сроком. Раньше здесь звался
  // issuePwaToken(USER_ID) без срока: если он успевал попасть в ту же
  // миллисекунду, expiresAt совпадал, HMAC совпадал, и «чужой» токен оказывался
  // подлинным — проверка падала примерно в половине прогонов.
  const [idPart, expPart] = issued.token.split('.');
  const otherSig = issuePwaToken(USER_ID, PWA_TOKEN_TTL_MS + 60_000).token.split('.')[2];

  check('подпись другого токена отклонена', verifyPwaToken(`${idPart}.${expPart}.${otherSig}`) === null);
}
check('битый base64 отклонён', verifyPwaToken('!!!.!!!.!!!') === null);
check('подпись неверной длины отклонена', verifyPwaToken(`${issued.token.split('.')[0]}.${issued.token.split('.')[1]}.AAAA`) === null);

{
  // Токен, подписанный чужим секретом: единственный способ получить валидную
  // подпись, не зная PWA_AUTH_SECRET.
  const restore = withSecret('b'.repeat(64));
  const foreign = issuePwaToken(USER_ID);
  restore();

  check('токен, подписанный другим секретом, не проходит', verifyPwaToken(foreign.token) === null);
}

console.log('\n— Срок —');

{
  const expired = issuePwaToken(USER_ID, -1000);
  check('истёкший токен отклонён', verifyPwaToken(expired.token) === null);
}

console.log(`\n${failures === 0 ? '✅' : '❌'} PWA-авторизация: ${checks - failures} ok, ${failures} ошибок\n`);
process.exit(failures === 0 ? 0 : 1);
