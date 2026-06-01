import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const s3Client = new S3Client(
  process.env.IS_LOCAL
    ? {
        region: 'us-east-2',
        endpoint: 'http://host.docker.internal:9090',
        forcePathStyle: true,
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      }
    : {
        region: 'auto',
        endpoint: process.env.R2_ENDPOINT,
        credentials: {
          accessKeyId: process.env.R2_ACCESS_KEY_ID,
          secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        },
      }
);

const BUCKET = process.env.IS_LOCAL
  ? (process.env.S3_BUCKET_NAME || 'my-test-bucket')
  : process.env.R2_BUCKET_NAME;

const streamToBuffer = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });

const getJson = async (key) => {
  const res = await s3Client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const buf = await streamToBuffer(res.Body);
  return JSON.parse(buf.toString());
};

const putJson = (key, obj) =>
  s3Client.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: JSON.stringify(obj, null, 2),
    ContentType: 'application/json',
  }));

const isNotFound = (err) => err?.name === 'NoSuchKey' || err?.Code === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404;

// V2 published statics live under the `v2/` key prefix on R2 (the FE reads
// https://groov-api.com/v2/index.json etc.). The bucket root holds the V1
// files, so every V2 key must carry this prefix.
const V2_PREFIX = 'v2/';

// Walk V2 sensor proteins and collect unique ligand names.
const collectLigandNames = (data) => {
  const names = new Set();
  for (const protein of data.proteins ?? []) {
    for (const stim of protein.stimulus ?? []) {
      // Tolerate both stimulusType (camelCase, written by addNewSensorV2) and stimulus_type (snake_case, migrated data)
      const types = stim.stimulusType ?? stim.stimulus_type ?? [];
      for (const t of types) {
        for (const m of t.small_molecule ?? []) {
          if (m?.name) names.add(m.name);
        }
      }
    }
  }
  return [...names];
};

const buildIndexEntry = (data, category, grv_id) => {
  const first = data.proteins?.[0] ?? {};
  return {
    id: grv_id,
    alias: first.alias ?? '',
    uniprot_id: first.uniprot_id ?? '',
    organism_name: first.origin?.[0]?.organism_name ?? '',
    category,
    ligands: collectLigandNames(data),
  };
};

const buildFamilyIndexEntry = (data, grv_id) => {
  const first = data.proteins?.[0] ?? {};
  return {
    id: grv_id,
    alias: first.alias ?? '',
    uniprot_id: first.uniprot_id ?? '',
    kegg_id: first.kegg_id ?? null,
    organism_name: first.origin?.[0]?.organism_name ?? '',
    ligands: collectLigandNames(data),
  };
};

const updateMainIndex = async (data, category, grv_id) => {
  let index;
  try {
    index = await getJson(`${V2_PREFIX}index.json`);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    index = { stats: { regulators: 0, ligands: 0 }, sensors: [] };
  }
  if (!Array.isArray(index.sensors)) index.sensors = [];
  const entry = buildIndexEntry(data, category, grv_id);
  const existing = index.sensors.findIndex((s) => s.id === grv_id);
  if (existing >= 0) index.sensors[existing] = entry;
  else index.sensors.push(entry);

  const allLigands = new Set();
  index.sensors.forEach((s) => (s.ligands ?? []).forEach((l) => allLigands.add(l)));
  index.stats = { regulators: index.sensors.length, ligands: allLigands.size };

  await putJson(`${V2_PREFIX}index.json`, index);
};

const updateFamilyIndex = async (data, category, grv_id) => {
  const key = `${V2_PREFIX}indexes/${category.toLowerCase()}.json`;
  let familyIndex;
  try {
    familyIndex = await getJson(key);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    familyIndex = { count: 0, data: [] };
  }
  const entry = buildFamilyIndexEntry(data, grv_id);
  const existing = familyIndex.data.findIndex((s) => s.id === grv_id);
  if (existing >= 0) familyIndex.data[existing] = entry;
  else familyIndex.data.push(entry);
  familyIndex.count = familyIndex.data.length;
  await putJson(key, familyIndex);
};

const saveSensorFile = async (data, category, grv_id) => {
  await putJson(`${V2_PREFIX}sensors/${category.toLowerCase()}/${grv_id}.json`, data);
};

const updateAllSensors = async (data) => {
  let all;
  try {
    all = await getJson(`${V2_PREFIX}all-sensors.json`);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    all = { version: new Date().toISOString(), count: 0, sensors: [] };
  }
  const existing = all.sensors.findIndex((s) => s.id === data.id);
  if (existing >= 0) all.sensors[existing] = data;
  else all.sensors.push(data);
  all.count = all.sensors.length;
  all.version = new Date().toISOString();
  await putJson(`${V2_PREFIX}all-sensors.json`, all);
};

const zeroPad = (n, w) => String(n).padStart(w, '0');

// Returns the next GRV-ID for the given single-character prefix by scanning R2 index.json.
// Per-prefix counters live implicitly in the index — one prefix per category for single-component
// sensors, plus prefix 'D' shared by all two-component sensors.
export const mintNextGrvId = async (prefix) => {
  let index;
  try {
    index = await getJson(`${V2_PREFIX}index.json`);
  } catch (err) {
    if (!isNotFound(err)) throw err;
    index = { sensors: [] };
  }
  const pat = new RegExp(`^GRV-${prefix}(\\d{5})$`);
  let max = 0;
  for (const s of index.sensors ?? []) {
    const m = s?.id ? pat.exec(s.id) : null;
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return `GRV-${prefix}${zeroPad(max + 1, 5)}`;
};

export const regenerateStaticJSON = async (data, category, grv_id) => {
  await updateMainIndex(data, category, grv_id);
  await updateFamilyIndex(data, category, grv_id);
  await saveSensorFile(data, category, grv_id);
  await updateAllSensors(data);
};
