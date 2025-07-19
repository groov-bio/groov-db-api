import { S3Client, PutObjectCommand, ListBucketsCommand, CreateBucketCommand } from "@aws-sdk/client-s3";
import fs from 'fs';
import path from 'path';
import * as globModule from 'glob';
import dotenv from 'dotenv';

dotenv.config();

const { glob } = globModule;
const BASE_DIR = path.join(process.cwd(), 's3');

// Configure S3 client to use local S3 mock
const s3Client = new S3Client({ 
  ...(process.env.IS_LOCAL ? {
    region: "us-east-2",
    endpoint: "http://localhost:9090",
    forcePathStyle: true,
    credentials: {
      accessKeyId: "test", 
      secretAccessKey: "test" 
    }
  } : {
    region: "auto", 
    endpoint: process.env.R2_ENDPOINT, 
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  })
});

const BUCKET_NAME = process.env.IS_LOCAL ? (process.env.S3_BUCKET_NAME || 'my-test-bucket') : process.env.R2_BUCKET_NAME;

// Ensure bucket exists
async function ensureBucketExists() {
  try {
    const { Buckets } = await s3Client.send(new ListBucketsCommand());
    console.log(Buckets);
    const bucketExists = Buckets?.some(bucket => bucket.Name === BUCKET_NAME);
    
    if (!bucketExists) {
      console.log(`Bucket '${BUCKET_NAME}' does not exist. Creating it...`);
      await s3Client.send(new CreateBucketCommand({ Bucket: BUCKET_NAME }));
      console.log(`Bucket '${BUCKET_NAME}' created successfully.`);
    } else {
      console.log(`Bucket '${BUCKET_NAME}' already exists.`);
    }
  } catch (error) {
    console.error('Error checking/creating bucket:', error);
    throw error;
  }
}

// Upload a file to S3
async function uploadFile(filePath) {
  try {
    const fileContent = fs.readFileSync(filePath);
    const key = path.relative(BASE_DIR, filePath);
    
    // Strip any bucket name prefix to prevent duplicate nesting
    let cleanKey = key;
    // If the key starts with the bucket name followed by a path separator, remove it
    if (cleanKey.startsWith(`${BUCKET_NAME}/`)) {
      cleanKey = cleanKey.substring(BUCKET_NAME.length + 1);
    }
    
    // Determine content type based on file extension
    let contentType = 'application/octet-stream';
    if (filePath.endsWith('.json')) {
      contentType = 'application/json';
    } else if (filePath.endsWith('.gz')) {
      contentType = 'application/gzip';
    }
    
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: cleanKey,
      Body: fileContent,
      ContentType: contentType
    });
    
    await s3Client.send(command);
    console.log(`Uploaded: ${cleanKey}`);
    return cleanKey;
  } catch (error) {
    console.error('Error uploading file:', filePath, error);
    throw error;
  }
}

// Upload all files from the s3 directory
async function uploadAllFiles() {
  try {
    const files = await glob(path.join(BASE_DIR, '**/*.*'));
    
    console.log(`Found ${files.length} files to upload.`);
    
    // Upload all files
    for (const file of files) {
      await uploadFile(file);
    }
    
    console.log('All files uploaded successfully!');
  } catch (error) {
    console.error('Error uploading files:', error);
    throw error;
  }
}

// Main function
async function main() {
  try {
    console.log('Starting upload to S3...');
    
    // Ensure the bucket exists
    await ensureBucketExists();
    
    // Upload all files
    await uploadAllFiles();
    
    console.log(`All files have been uploaded to the '${BUCKET_NAME}' bucket.`);
  } catch (error) {
    console.error('Failed to complete the upload process:', error);
    process.exit(1);
  }
}

// Run the script
main(); 