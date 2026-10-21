import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const directories: string[] = [];
const now = 1_800_000_000;
const authUrl =
  "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const appUrl = "https://firebaseappcheck.googleapis.com/v1/jwks";
const config = {
  projectId: "sureneco-test",
  projectNumber: "123456789012",
  appId: "1:123456789012:android:0123456789abcdef",
};
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
const jwk = keys.publicKey.export({ format: "jwk" });
const fixtures = {
  [authUrl]: { body: JSON.stringify({ "test-key": publicPem }), maxAge: 300 },
  [appUrl]: {
    body: JSON.stringify({
      keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }],
    }),
    maxAge: 300,
  },
};

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function token(
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
  privateKey = keys.privateKey,
) {
  const encoded = [
    Buffer.from(
      JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key", ...header }),
    ).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
  ].join(".");
  return `${encoded}.${sign("RSA-SHA256", Buffer.from(encoded), privateKey).toString("base64url")}`;
}

function idClaims(changes: Record<string, unknown> = {}) {
  return {
    iss: `https://securetoken.google.com/${config.projectId}`,
    aud: config.projectId,
    sub: "anonymous-device-a",
    iat: now - 60,
    exp: now + 3600,
    auth_time: now - 120,
    firebase: { sign_in_provider: "anonymous" },
    ...changes,
  };
}

function appClaims(changes: Record<string, unknown> = {}) {
  return {
    iss: `https://firebaseappcheck.googleapis.com/${config.projectNumber}`,
    aud: [`projects/${config.projectNumber}`],
    sub: config.appId,
    iat: now - 60,
    exp: now + 3600,
    ...changes,
  };
}

function headers(id = token(idClaims()), app = token(appClaims())) {
  return { HTTP_AUTHORIZATION: `Bearer ${id}`, HTTP_X_FIREBASE_APPCHECK: app };
}

const harness = String.raw`
require 'server/auth.php';
$input = json_decode(file_get_contents($argv[1]), true, 32, JSON_THROW_ON_ERROR);
$calls = [];
try {
    $verifier = new Sureneco\FirebaseTokenVerifier(
        $input['config'],
        function (string $url) use ($input, &$calls): array {
            $calls[] = $url;
            if (!isset($input['fixtures'][$url])) {
                throw new RuntimeException('fixture endpoint unavailable: secret');
            }
            return $input['fixtures'][$url];
        },
        fn (): int => $input['now']
    );
    $results = [];
    foreach ($input['requests'] as $server) {
        try {
            $results[] = ['identity' => Sureneco\authenticateFirebaseRequest($server, $verifier)];
        } catch (Sureneco\FirebaseAuthException $error) {
            $results[] = ['status' => $error->status, 'error' => $error->errorCode, 'message' => $error->getMessage()];
        }
    }
    echo json_encode(['results' => $results, 'calls' => $calls], JSON_THROW_ON_ERROR);
} catch (Sureneco\FirebaseAuthException $error) {
    echo json_encode(['status' => $error->status, 'error' => $error->errorCode, 'message' => $error->getMessage()], JSON_THROW_ON_ERROR);
}
`;

async function verify(
  requests: Record<string, unknown>[],
  options: {
    config?: Record<string, unknown>;
    fixtures?: Record<string, unknown>;
    now?: number;
  } = {},
) {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "sureneco-firebase-"));
  directories.push(cacheDirectory);
  const inputPath = join(cacheDirectory, "request.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      config: { ...config, cacheDirectory, ...options.config },
      fixtures: options.fixtures ?? fixtures,
      requests,
      now: options.now ?? now,
    }),
  );
  const result = await execute("php", ["-r", harness, inputPath], {
    cwd: root,
    timeout: 5_000,
  });
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

function rejected(result: { results: unknown[] }, index = 0) {
  expect(result.results[index]).toEqual({
    status: 401,
    error: "unauthorized",
    message: "Authentication required.",
  });
}

it("verifies real RSA signatures, anonymous identity and App Check using only fixed Google endpoints", async () => {
  const result = await verify([headers(), headers()]);
  expect(result.results).toEqual([
    { identity: { uid: "anonymous-device-a", appId: config.appId } },
    { identity: { uid: "anonymous-device-a", appId: config.appId } },
  ]);
  expect(result.calls).toEqual([authUrl, appUrl]);
});

it.each([
  ["expired", { exp: now }],
  ["wrong issuer", { iss: "https://securetoken.google.com/other-project" }],
  ["wrong audience", { aud: "other-project" }],
  ["array audience", { aud: [config.projectId] }],
  ["future issuance", { iat: now + 1 }],
  ["fractional issuance", { iat: now - 0.5 }],
  ["string expiry", { exp: String(now + 100) }],
  ["expiry before issuance", { iat: now - 10, exp: now - 20 }],
  ["empty subject", { sub: "" }],
  ["long subject", { sub: "a".repeat(129) }],
  ["non-string subject", { sub: 42 }],
  ["control subject", { sub: "device\u0000hidden" }],
  ["non-anonymous provider", { firebase: { sign_in_provider: "password" } }],
  ["missing provider", { firebase: {} }],
  ["future authentication", { auth_time: now + 1 }],
  ["missing authentication time", { auth_time: null }],
] satisfies [string, Record<string, unknown>][])(
  "rejects ID token %s claims",
  async (_name, changes) => {
    rejected(await verify([headers(token(idClaims(changes)))]));
  },
);

it.each([
  ["expired", { exp: now }],
  ["wrong issuer", { iss: "https://firebaseappcheck.googleapis.com/999" }],
  ["wrong project audience", { aud: ["projects/999"] }],
  ["missing audience", { aud: [] }],
  ["scalar audience", { aud: `projects/${config.projectNumber}` }],
  ["wrong app ID", { sub: "1:123456789012:android:ffffffffffffffff" }],
  ["missing app ID", { sub: "" }],
  ["future issuance", { iat: now + 1 }],
  ["string expiry", { exp: String(now + 10) }],
] satisfies [string, Record<string, unknown>][])(
  "rejects App Check %s claims",
  async (_name, changes) => {
    rejected(
      await verify([headers(token(idClaims()), token(appClaims(changes)))]),
    );
  },
);

it.each([
  { alg: "none" },
  { alg: "HS256" },
  { alg: "RS512" },
  { kid: "unknown-key" },
  { kid: "../remote" },
  { kid: null },
  { typ: "other" },
  { jku: "https://attacker.invalid/keys" },
  { crit: ["unknown"] },
])("rejects unsafe JWT header %j for both token kinds", async (header) => {
  const result = await verify([
    headers(token(idClaims(), header)),
    headers(token(idClaims()), token(appClaims(), header)),
  ]);
  rejected(result, 0);
  rejected(result, 1);
  expect(
    result.calls.every((url: string) => [authUrl, appUrl].includes(url)),
  ).toBe(true);
});

it("rejects forged signatures and tampered payloads for both token kinds", async () => {
  const tampered = token(idClaims()).split(".");
  tampered[1] = Buffer.from(
    JSON.stringify(idClaims({ sub: "other-device" })),
  ).toString("base64url");
  const result = await verify([
    headers(token(idClaims(), {}, otherKeys.privateKey)),
    headers(token(idClaims()), token(appClaims(), {}, otherKeys.privateKey)),
    headers(tampered.join(".")),
  ]);
  for (let index = 0; index < 3; index++) rejected(result, index);
});

it.each([
  {},
  {
    HTTP_AUTHORIZATION: "fcm-token",
    HTTP_X_FIREBASE_APPCHECK: token(appClaims()),
  },
  {
    ...headers(),
    HTTP_AUTHORIZATION: `Bearer ${token(idClaims())},Bearer fake`,
  },
  { ...headers(), HTTP_AUTHORIZATION: `Bearer  ${token(idClaims())}` },
  { ...headers(), HTTP_AUTHORIZATION: [`Bearer ${token(idClaims())}`] },
  {
    ...headers(),
    HTTP_AUTHORIZATION: `Bearer ${token(idClaims())}\r\nInjected: true`,
  },
  { ...headers(), HTTP_X_FIREBASE_APPCHECK: "" },
  { ...headers(), HTTP_X_FIREBASE_APPCHECK: [token(appClaims())] },
  { ...headers(), HTTP_X_FIREBASE_APPCHECK: `${token(appClaims())},fake` },
  { ...headers(), HTTP_AUTHORIZATION: `Bearer ${"a".repeat(16_385)}` },
  { ...headers(), HTTP_AUTHORIZATION: "Bearer e30=.e30=.AAAA" },
  { ...headers(), HTTP_AUTHORIZATION: "Bearer e30.e30.A" },
  { ...headers(), HTTP_AUTHORIZATION: "Bearer e30.W10.AAAA" },
])(
  "rejects malformed or missing request headers without leaking credentials",
  async (server) => {
    rejected(await verify([server]));
  },
);

it.each([
  { projectId: "" },
  { projectId: "https://attacker.invalid" },
  { projectNumber: "" },
  { projectNumber: "123/path" },
  { appId: "" },
  { appId: "1:999:android:0123456789abcdef" },
  { cacheDirectory: join(root, "server/public/keys") },
])("fails closed on invalid configuration %j", async (invalid) => {
  expect(await verify([headers()], { config: invalid })).toEqual({
    status: 503,
    error: "authentication_unavailable",
    message: "Authentication unavailable.",
  });
});

it("missing production Firebase environment fails closed before authentication", async () => {
  const result = await execute(
    "php",
    [
      "-r",
      String.raw`
    require 'server/auth.php';
    try { Sureneco\authenticateFirebaseRequest([]); }
    catch (Sureneco\FirebaseAuthException $error) {
      echo json_encode(['status' => $error->status, 'error' => $error->errorCode]);
    }
  `,
    ],
    {
      cwd: root,
      timeout: 5_000,
      env: {
        ...process.env,
        SURENECO_FIREBASE_PROJECT_ID: "",
        SURENECO_FIREBASE_PROJECT_NUMBER: "",
        SURENECO_FIREBASE_APP_ID: "",
      },
    },
  );
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    status: 503,
    error: "authentication_unavailable",
  });
});

it("key fetch errors are sanitized and never authorize the request", async () => {
  const result = await verify([headers()], { fixtures: {} });
  expect(result.results[0]).toEqual({
    status: 503,
    error: "authentication_unavailable",
    message: "Authentication unavailable.",
  });
});

it.each([
  { body: "not JSON", maxAge: 300 },
  { body: "x".repeat(262_145), maxAge: 300 },
  { body: JSON.stringify({ "test-key": "not a public key" }), maxAge: 300 },
])(
  "rejects invalid certificate responses without credential leakage",
  async (fixture) => {
    const result = await verify([headers()], {
      fixtures: { ...fixtures, [authUrl]: fixture },
    });
    expect(result.results[0]).toEqual({
      status: 503,
      error: "authentication_unavailable",
      message: "Authentication unavailable.",
    });
  },
);

it("does not refetch fresh keys on attacker-controlled unknown kid values", async () => {
  const result = await verify([
    headers(),
    headers(token(idClaims(), { kid: "unknown-one" })),
    headers(token(idClaims(), { kid: "unknown-two" })),
  ]);
  rejected(result, 1);
  rejected(result, 2);
  expect(result.calls).toEqual([authUrl, appUrl]);
});

it("shares cached certificates across PHP requests but never uses expired keys on fetch failure", async () => {
  const cacheDirectory = await mkdtemp(
    join(tmpdir(), "sureneco-firebase-shared-"),
  );
  directories.push(cacheDirectory);
  const first = await verify([headers()], { config: { cacheDirectory } });
  expect(first.calls).toEqual([authUrl, appUrl]);
  const cached = await verify([headers()], {
    config: { cacheDirectory },
    fixtures: {},
  });
  expect(cached.results[0]).toEqual({
    identity: { uid: "anonymous-device-a", appId: config.appId },
  });
  expect(cached.calls).toEqual([]);
  const expired = await verify([headers()], {
    config: { cacheDirectory },
    fixtures: {},
    now: now + 301,
  });
  expect(expired.results[0]).toEqual({
    status: 503,
    error: "authentication_unavailable",
    message: "Authentication unavailable.",
  });
});

it.each([
  { keys: [] },
  { keys: [{ ...jwk, kid: "test-key", alg: "HS256", use: "sig" }] },
  { keys: [{ ...jwk, kid: "test-key", kty: "EC", use: "sig" }] },
  { keys: [{ ...jwk, kid: "test-key", n: "bad=", use: "sig" }] },
])("fails closed on malformed App Check JWKS %j", async (response) => {
  const result = await verify([headers()], {
    fixtures: {
      ...fixtures,
      [appUrl]: { body: JSON.stringify(response), maxAge: 300 },
    },
  });
  expect(result.results[0]).toEqual({
    status: 503,
    error: "authentication_unavailable",
    message: "Authentication unavailable.",
  });
});
