import {mkdirSync} from "node:fs";
import {dirname,join} from "node:path";

export const s3FixtureVersion = "versitygw v1.11.0";

export function s3Fixture(root:string, endpoint:string, directory:string, credentials:{accessKeyId:string;secretAccessKey:string}) {
  mkdirSync(directory,{recursive:true});
  const metadata=join(dirname(directory),"metadata");
  mkdirSync(metadata,{recursive:true});
  return {
    command:[process.env.VERSITYGW_BIN??join(root,".local/bin/versitygw"),"--port",new URL(endpoint).host,"--region","us-east-1","--quiet","posix","--sidecar",metadata,directory],
    env:{ROOT_ACCESS_KEY_ID:credentials.accessKeyId,ROOT_SECRET_ACCESS_KEY:credentials.secretAccessKey},
  };
}
