import { resolve } from 'node:path';
import { wrapWindowsUpdateZip } from '../electron/update-archive-tools';
function argument(name:string){const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];}
const input=argument('--input'),output=argument('--output');
if(!input||!output){console.error('Usage: node --import tsx scripts/wrap-windows-update.ts --input Windows-root.zip --output Watson-update.zip [--bundle-path Watson]');process.exitCode=1;}
else void wrapWindowsUpdateZip(resolve(input),resolve(output),argument('--bundle-path')??'Watson').then(result=>console.log(JSON.stringify({...result,signatureVerified:false,note:'Repacking only. Native signature verification and signed manifest production are separate release gates.'},null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
