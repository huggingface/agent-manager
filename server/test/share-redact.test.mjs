// The share redaction ruleset (scripts/share-redact.mjs): every format it is
// meant to catch, and ordinary text it must leave alone. Any non-email hit
// blocks a share, so a false positive here is a share the operator can't make.
//
// Every "secret" below is synthetic and assembled at runtime, so no
// secret-shaped literal sits in this file for a scanner to trip on.
//   node --test test/share-redact.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRedactor, RULE_NAMES } from '../../scripts/share-redact.mjs';

const j = (...parts) => parts.join('');
const rep = (c, n) => c.repeat(n);
const alnum = (n) => rep('aB3x', Math.ceil(n / 4)).slice(0, n);
const upper = (n) => rep('Q7ZK', Math.ceil(n / 4)).slice(0, n);
const b64 = (n) => rep('Ab9/+zY2', Math.ceil(n / 8)).slice(0, n);

// [rule, synthetic secret, how it might appear in a trace]
const SECRETS = [
  ['github-token', j('github', '_pat_', '11ABCDEFG0', alnum(12), '_', alnum(59))],
  ['github-token', j('gh', 'o_', alnum(36))],
  ['github-token', j('gh', 'u_', alnum(36))],
  ['github-token', j('gh', 's_', alnum(36))],
  ['github-token', j('gh', 'p_', alnum(36))],
  ['aws-key-id', j('AK', 'IA', upper(16))],
  ['aws-key-id', j('AS', 'IA', upper(16))],
  ['slack-token', j('xo', 'xb-', '1234567890', '-', '9876543210', '-', alnum(24))],
  ['slack-token', j('xo', 'xp-', '1234567890', '-', '1234567890123', '-', alnum(32))],
  ['slack-token', j('xa', 'pp-', '1', '-', 'A0123BCDEFG', '-', '1234567890123', '-', rep('0f9e', 16))],
  ['stripe-key', j('sk', '_live_', alnum(24))],
  ['stripe-key', j('rk', '_live_', alnum(24))],
  ['npm-token', j('np', 'm_', alnum(36))],
  ['openai-key', j('sk', '-proj-', alnum(40), '_', alnum(40), '-', alnum(20))],
  ['openai-key', j('sk', '-svcacct-', alnum(40), '-', alnum(30))],
  ['openai-key', j('sk', '-', alnum(48))],
  ['anthropic-key', j('sk', '-ant-', 'api03-', alnum(80), '-', alnum(10))],
  ['google-key', j('AI', 'za', 'Sy', alnum(33))],
  ['jwt', j('ey', 'J', alnum(30), '.', 'ey', 'J', alnum(40), '.', alnum(43))],
  ['hf-jwt', j('hf', '_jwt_', 'ey', 'J', alnum(30), '.', alnum(40), '.', alnum(20))],
  ['hf-token', j('hf', '_', alnum(34))],
];

const redactLine = (obj, env = {}) => {
  const { redact, hits } = makeRedactor({ env });
  return { out: redact(JSON.stringify(obj)), hits };
};

for (const [rule, secret] of SECRETS) {
  test(`${rule}: ${secret.slice(0, 12)}… is redacted`, () => {
    // Inside a tool result, the shape a trace actually carries.
    const { out, hits } = redactLine({ type: 'user', content: `output:\n  token=${secret} (ok)` });
    assert.ok(!out.includes(secret), `secret survived: ${out}`);
    assert.ok(hits[rule] >= 1, `expected a ${rule} hit, got ${JSON.stringify(hits)}`);
    assert.match(out, new RegExp(`«redacted:${rule}»`));
  });
}

test('AWS secret access keys are redacted when labelled, keeping the label', () => {
  const secret = b64(40);
  const forms = [
    `aws_secret_access_key = ${secret}`,
    `AWS_SECRET_ACCESS_KEY=${secret}`,
    `export AWS_SECRET_ACCESS_KEY="${secret}"`,
    JSON.stringify({ Credentials: { SecretAccessKey: secret } }),
  ];
  for (const f of forms) {
    const { out, hits } = redactLine({ content: f });
    assert.ok(!out.includes(secret), `survived in: ${f}`);
    assert.equal(hits['aws-secret-key'], 1, f);
    assert.match(out, /secret_?access_?key/i, 'label kept');
  }
});

test('PEM private keys lose their whole body, not just the header', () => {
  const body = [b64(64), b64(64), b64(20)];
  for (const kind of ['RSA PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'PRIVATE KEY', 'EC PRIVATE KEY']) {
    const pem = `-----BEGIN ${kind}-----\n${body.join('\n')}\n-----END ${kind}-----\n`;
    const { out, hits } = redactLine({ content: `cat key:\n${pem}done` });
    for (const line of body) assert.ok(!out.includes(line), `body line survived for ${kind}`);
    assert.equal(hits['private-key'], 1, kind);
    assert.match(out, /done/, 'text after the key is kept');
  }
  // Truncated: header with no footer (e.g. `head -3 id_rsa`).
  const cut = `-----BEGIN RSA PRIVATE KEY-----\n${body[0]}\n${body[1]}`;
  const t = redactLine({ content: cut });
  for (const line of body.slice(0, 2)) assert.ok(!t.out.includes(line), 'truncated body survived');
  // A bare OpenSSH body (header cut off).
  const bare = j('b3Blbn', 'NzaC1rZXktdjE', 'AAAABG5vbmU', b64(40));
  const b = redactLine({ content: `line 2: ${bare}` });
  assert.ok(!b.out.includes(bare));
  assert.equal(b.hits['private-key'], 1);
});

test('signed URLs lose their __sign credential', () => {
  const sig = j('ey', 'J', alnum(20), '.', alnum(30), '.', alnum(20));
  const urlA = `https://cas-bridge.xethub.hf.co/xet-bridge-us/abc?X-Amz-Date=1&__sign=${sig}`;
  const urlB = `https://huggingface.co/api/resolve-cache/x?__sign=${alnum(30)}%3D`;
  for (const u of [urlA, urlB]) {
    const { out, hits } = redactLine({ content: `GET ${u}` });
    assert.ok(!out.includes(sig) && !out.includes(alnum(30)), out);
    assert.ok(hits['signed-url'] >= 1, JSON.stringify(hits));
  }
});

test('env values are still caught, whatever they look like', () => {
  const value = 'zz-not-a-known-shape-42';
  const { out, hits } = redactLine({ content: `using ${value}` }, { MY_CORP_TOKEN: value });
  assert.ok(!out.includes(value));
  assert.equal(hits['env:MY_CORP_TOKEN'], 1);
});

test('ordinary text does not trip a secret rule', () => {
  const benign = [
    'pip install scikit-learn; import sklearn; sk-learn is not a key',
    'git log 3f786850e387550fdab836ed7e6dc881de23001b and sha256 ' + 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'uuid 0f8fad5b-d9cb-469f-a165-70867728950e, request id req_011CU2aaaaaaaa',
    'set npm_config_cache=/tmp/npm and NPM_TOKEN is read from the env',
    'github_pat_ tokens start with that prefix; gho_ is an OAuth token',
    'the disk_live_metrics table; ask_live_question(); sk_test_ is for tests',
    'xoxo-hugs and xoxb- is the Slack bot prefix',
    'AKIA is the access-key prefix; AKIAEXAMPLE is too short',
    // IAM unique ids at full length: identifiers, not credentials.
    ...['AIDA', 'AGPA', 'AROA', 'AIPA', 'ANPA', 'ANVA', 'APKA', 'ABIA', 'ACCA'].map((p) =>
      JSON.stringify({ UserId: `${p}${upper(16)}`, Arn: 'arn:aws:iam::123456789012:role/x' })),
    'xapp is the Slack app-token prefix; xapp-1 alone is not a token',
    'aws_secret_access_key = <your secret here>',
    'base64 of a random blob: ' + b64(40),
    'eyJhbGciOiJIUzI1NiJ9 is only a JWT header',
    'the -----BEGIN CERTIFICATE----- block is public',
    'hf_hub_download(repo_id) and hf_transfer and hf_jwt_ prefix',
    'https://huggingface.co/datasets/x?download=true&__signature_style=v4',
    'AIzaSy is the Google key prefix',
  ];
  for (const text of benign) {
    const { out, hits } = redactLine({ content: text });
    const secretHits = Object.keys(hits).filter((r) => r !== 'email');
    assert.deepEqual(secretHits, [], `false positive on: ${text} → ${JSON.stringify(hits)}`);
    assert.equal(out, JSON.stringify({ content: text }));
  }
});

test('every rule is exercised by a positive case above', () => {
  const covered = new Set([...SECRETS.map(([r]) => r), 'aws-secret-key', 'private-key', 'signed-url', 'email']);
  for (const r of RULE_NAMES) assert.ok(covered.has(r), `rule ${r} has no positive test`);
});
