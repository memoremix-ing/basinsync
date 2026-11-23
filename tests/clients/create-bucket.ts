import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";

for (const name of ["S3_ENDPOINT", "S3_BUCKET", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"])
  if (!process.env[name]) throw new Error(`set ${name}`);
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.AWS_REGION ?? "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
    ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
  },
});
try {
  await s3.send(new CreateBucketCommand({ Bucket: process.env.S3_BUCKET! }));
  console.log(`put of success: bucket ${process.env.S3_BUCKET}`);
} finally { s3.destroy(); }
