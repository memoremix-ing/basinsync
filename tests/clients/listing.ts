import { ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";

// VersityGW's POSIX backend lists an in-flight PUT as `.<name>.sgwtmp.<n>`
// beside its key; real S3 never lists an incomplete upload.
const inFlight = /(^|\/)\.[^/]*\.sgwtmp\.\d+$/;

/** Keys under a prefix whose uploads have completed. */
export async function committedKeys(s3: S3Client, bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    keys.push(...(page.Contents ?? []).map(o => o.Key!).filter(k => !inFlight.test(k)));
    token = page.NextContinuationToken;
  } while (token);
  return keys;
}
