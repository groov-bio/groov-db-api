import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

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

// V2 published statics live under the `v2/` key prefix on R2 (bucket root holds V1).
const V2_PREFIX = 'v2/';

export const removeStaticJSON = async (category, grv_id) => {
  const errors = [];

  // 1. index.json — filter out the sensor, recompute stats
  try {
    let index;
    try {
      index = await getJson(`${V2_PREFIX}index.json`);
    } catch (err) {
      if (isNotFound(err)) {
        console.log('index.json not found, skipping');
        index = null;
      } else {
        throw err;
      }
    }
    if (index !== null) {
      index.sensors = (index.sensors ?? []).filter((s) => s.id !== grv_id);
      const allLigands = new Set();
      index.sensors.forEach((s) => (s.ligands ?? []).forEach((l) => allLigands.add(l)));
      index.stats = { regulators: index.sensors.length, ligands: allLigands.size };
      await putJson(`${V2_PREFIX}index.json`, index);
    }
  } catch (err) {
    console.log('Failed to update index.json:', err);
    errors.push(err);
  }

  // 2. indexes/{category}.json — filter out the sensor, recompute count
  try {
    const key = `${V2_PREFIX}indexes/${category.toLowerCase()}.json`;
    let familyIndex;
    try {
      familyIndex = await getJson(key);
    } catch (err) {
      if (isNotFound(err)) {
        console.log(`${key} not found, skipping`);
        familyIndex = null;
      } else {
        throw err;
      }
    }
    if (familyIndex !== null) {
      familyIndex.data = (familyIndex.data ?? []).filter((s) => s.id !== grv_id);
      familyIndex.count = familyIndex.data.length;
      await putJson(key, familyIndex);
    }
  } catch (err) {
    console.log(`Failed to update indexes/${category.toLowerCase()}.json:`, err);
    errors.push(err);
  }

  // 3. sensors/{category}/{grv_id}.json — delete the object
  try {
    const key = `${V2_PREFIX}sensors/${category.toLowerCase()}/${grv_id}.json`;
    try {
      await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    } catch (err) {
      if (isNotFound(err)) {
        console.log(`${key} not found, nothing to delete`);
      } else {
        throw err;
      }
    }
  } catch (err) {
    console.log(`Failed to delete sensors/${category.toLowerCase()}/${grv_id}.json:`, err);
    errors.push(err);
  }

  // 4. all-sensors.json — filter out the sensor, recompute count and version
  try {
    let all;
    try {
      all = await getJson(`${V2_PREFIX}all-sensors.json`);
    } catch (err) {
      if (isNotFound(err)) {
        console.log('all-sensors.json not found, skipping');
        all = null;
      } else {
        throw err;
      }
    }
    if (all !== null) {
      all.sensors = (all.sensors ?? []).filter((s) => s.id !== grv_id);
      all.count = all.sensors.length;
      all.version = new Date().toISOString();
      await putJson(`${V2_PREFIX}all-sensors.json`, all);
    }
  } catch (err) {
    console.log('Failed to update all-sensors.json:', err);
    errors.push(err);
  }

  if (errors.length > 0) {
    throw new Error(`R2 removal completed with ${errors.length} error(s); see logs for details`);
  }
};
