import type { CloudClient } from './cloud-client';
import type { CloudRecordingSelection } from '../shared/cloud-types';
type Client = Pick<CloudClient,'status'|'recordingCapabilities'|'recordingInfo'|'selectRecordingFile'|'downloadRecording'>;
interface Options {
  client:()=>Client|undefined; assertIdle:()=>void;
  pick:(options:{title:string;extensions:string[]})=>Promise<string|undefined>;
  save:(options:{title:string;filename:string})=>Promise<string|undefined>;
}
const formats:Record<string,string[]>={'audio/wav':['wav'],'audio/webm':['webm'],'audio/mp4':['mp4','m4a','m4b'],'audio/mpeg':['mp3'],'audio/ogg':['ogg','oga'],'audio/x-caf':['caf']};
// Only main-process native dialogs supply paths. IPC receives metadata, never
// a caller-supplied path, bearer, signed URL, or the contents of a recording.
export class RecordingBroker {
  private dialogActive=false;
  constructor(private options:Options){}
  private actor(client:Client,meetingId:string){const status=client.status();if(!status.signedIn||!status.user?.id)throw new Error('Sign in to attach or download private audio.');if(!status.boundRecords.some(record=>record.entity==='meeting'&&record.id===meetingId))throw new Error('Sync this session to your account before managing its audio attachment.');return JSON.stringify([status.endpoint,status.user.id,status.deviceId]);}
  private begin(meetingId:string){this.options.assertIdle();if(this.dialogActive)throw new Error('Finish the open audio file dialog first.');const client=this.options.client();if(!client)throw new Error('Cloud features are unavailable.');const actor=this.actor(client,meetingId);this.dialogActive=true;return {client,actor};}
  private verify(client:Client,actor:string,meetingId:string){this.options.assertIdle();if(this.options.client()!==client||this.actor(client,meetingId)!==actor)throw new Error('The cloud account or server changed while the file dialog was open. Choose the file again.');}
  async pick(meetingId:string):Promise<{selected:boolean;selection?:CloudRecordingSelection}>{const {client,actor}=this.begin(meetingId);try{const capabilities=await client.recordingCapabilities();this.verify(client,actor,meetingId);if(!capabilities.configured)throw new Error('The server operator must configure private audio storage first.');if(!capabilities.recordingAllowed)throw new Error('Your organization disables audio attachments.');const extensions=[...new Set(capabilities.supportedContentTypes.flatMap(type=>formats[type]??[]))];if(!extensions.length)throw new Error('The server supports no selectable audio format.');const path=await this.options.pick({title:'Choose a private audio attachment',extensions});if(!path)return {selected:false};this.verify(client,actor,meetingId);const selection=await client.selectRecordingFile({meetingId,path});this.verify(client,actor,meetingId);return {selected:true,selection};}finally{this.dialogActive=false;}}
  async download(meetingId:string):Promise<{saved:boolean;path?:string}>{const {client,actor}=this.begin(meetingId);try{const {recording}=await client.recordingInfo(meetingId);this.verify(client,actor,meetingId);if(!recording)throw new Error('This session has no audio attachment.');const filename=(recording.filename??`watson-audio.${formats[recording.contentType]?.[0]??'audio'}`).replace(/[\\/\u0000-\u001f]/g,'_').slice(0,200);const destination=await this.options.save({title:'Save private audio attachment',filename});if(!destination)return {saved:false};this.verify(client,actor,meetingId);return client.downloadRecording({meetingId,destination});}finally{this.dialogActive=false;}}
}
