import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const args=process.argv.slice(2);const value=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const platform=value('--platform')??process.platform;const version=value('--version');const bundle=value('--bundle');const output=value('--output');
if(!version||!bundle||!output){console.error('Usage: node scripts/managed-release-plan.mjs --platform darwin --version x.y.z --bundle release/mac-arm64/Watson.app --output release/Watson-x.y.z.pkg [--execute]');process.exit(1);}
if(!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))throw new Error('Invalid release version');
const plan=[];const gates=[];
if(platform==='darwin'){
  const app=path.resolve(bundle),pkg=path.resolve(output),unsigned=`${pkg}.unsigned.pkg`;
  if(!process.env.WATSON_DEVELOPER_ID_INSTALLER)gates.push('WATSON_DEVELOPER_ID_INSTALLER must name an existing Developer ID Installer identity.');
  if(!process.env.WATSON_NOTARY_PROFILE)gates.push('WATSON_NOTARY_PROFILE must name existing notarization credentials; this script never creates or changes Keychain credentials.');
  plan.push(['/usr/bin/codesign','--verify','--deep','--strict',app],['/usr/sbin/spctl','--assess','--type','execute',app],['/usr/bin/pkgbuild','--component',app,'--install-location','/Applications','--identifier','com.watson.app.pkg','--version',version,unsigned],['/usr/bin/productbuild','--package',unsigned,'--sign',process.env.WATSON_DEVELOPER_ID_INSTALLER??'<Developer ID Installer identity>',pkg],['xcrun','notarytool','submit',pkg,'--keychain-profile',process.env.WATSON_NOTARY_PROFILE??'<existing notarization profile>','--wait'],['xcrun','stapler','staple',pkg],['/usr/sbin/pkgutil','--check-signature',pkg]);
}else if(platform==='win32'){
  if(!process.env.CSC_LINK||!process.env.CSC_KEY_PASSWORD)gates.push('CSC_LINK and CSC_KEY_PASSWORD must supply the existing Authenticode certificate to electron-builder.');
  plan.push([process.execPath,path.resolve('node_modules/electron-builder/out/cli/cli.js'),'--win','nsis','zip','--publish','never']);
}else throw new Error('Managed release packaging supports macOS and Windows.');
console.log(JSON.stringify({platform,version,bundle:path.resolve(bundle),output:path.resolve(output),gates,commands:plan,execute:args.includes('--execute')},null,2));
if(args.includes('--execute')){
  if(process.platform!==platform||gates.length)throw new Error('Native packaging host and signing/notarization configuration are required.');
  if(!existsSync(path.resolve(bundle)))throw new Error('Bundle does not exist.');
  for(const [cmd,...commandArgs] of plan){const result=spawnSync(cmd,commandArgs,{stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)throw new Error(`Release verification/packaging stopped at ${cmd}.`);}
}
