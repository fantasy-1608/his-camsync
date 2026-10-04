import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {test} from 'node:test';

const manualContext={window:{},console,Date,DataTransfer:class {constructor(){this.files=[];this.items={add:file=>this.files.push(file)};}}};
vm.createContext(manualContext);
vm.runInContext(fs.readFileSync(new URL('../extension/content/manual-attachment.js',import.meta.url),'utf8'),manualContext);
const manual=manualContext.window.__CamSyncManual;
function inputFixture(multiple=true) {
 const doc={defaultView:{getComputedStyle:()=>({display:'block',visibility:'visible'})}};
 return {type:'file',multiple,files:[],disabled:false,isConnected:true,ownerDocument:doc};
}
test('manual attachment preserves selected files and invokes no host events or uploads',()=>{
 const input=inputFixture();const before={name:'selected.jpg'};const file={name:'new.jpg'};input.files=[before];
 input.click=()=>assert.fail('No click allowed');input.dispatchEvent=()=>assert.fail('No host onchange allowed');
 const result=manual.attach(input,[file]);assert.equal(result.status,'FILE_READY');assert.equal(result.manualUpload,true);assert.deepEqual(input.files,[before,file]);
});
test('occupied single file input is preserved until user uploads or clears it',()=>{
 const input=inputFixture(false);input.files=[{name:'selected.pdf'}];const before=input.files;
 assert.equal(manual.attach(input,[{name:'new.pdf'}]).code,'INPUT_OCCUPIED');assert.equal(input.files,before);
});
test('detached, disabled and closed frame targets are rejected',()=>{
 for(const configure of [i=>i.isConnected=false,i=>i.disabled=true,i=>i.ownerDocument.defaultView.closed=true,
 i=>i.ownerDocument.defaultView.frameElement={isConnected:false}]){
 const input=inputFixture();configure(input);assert.equal(manual.attach(input,[{}]).code,'TARGET_UNAVAILABLE');assert.equal(input.files.length,0);
 }
});
test('missing clinical IDs and conflicting sibling forms cannot block name-only pairing',()=>{
 const sibling={body:{innerText:'Tên bệnh nhân: WRONG'}};
 const parent={body:{innerText:'Tên bệnh nhân: NGUYỄN VĂN MẪU - Tuổi: 60'},getElementById:()=>null,querySelectorAll:()=>[sibling]};
 const child={body:{innerText:''},getElementById:()=>null,defaultView:{frameElement:{ownerDocument:parent}}};
 assert.equal(manual.readName(child),'NGUYỄN VĂN MẪU');assert.equal(manual.readName({body:{innerText:''}}),'');
});
test('filenames retain name, timestamp, transfer uniqueness and actual MIME extension',()=>{
 const when=new Date(2026,9,4,12,30,59);
 assert.equal(manual.filename('Đặng Văn Mẫu','image/jpeg','transfer01',when),'DANG_VAN_MAU_20261004_123059_ansfer01.jpg');
 for(const mime of ['image/jpeg','image/png','application/pdf']){
 const name=manual.filename('../../<bad>\\name\u0000',''+mime,'unique_transfer',when);
 assert.ok(!/[\\/<>\u0000]/.test(name));assert.ok(name.length<130);
 }
 assert.match(manual.filename('','application/pdf','transfer',when),/^TAI_LIEU_/);
 assert.throws(()=>manual.filename('X','text/html','id',when),/UNSUPPORTED/);
});
test('ambiguous file inputs do not silently select a different form',()=>{
 assert.equal(manual.findInput({getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[{},{}]}),null);
});

function clientFixture(){
 const sandbox={window:{location:{hash:'',search:''}},navigator:{userAgent:'Synthetic'},crypto:webcrypto,TextEncoder,TextDecoder,atob,btoa,
 Blob,console:{log(){},warn(){}},setTimeout,clearTimeout,setInterval,clearInterval,
 FileReader:class {readAsDataURL(blob){blob.arrayBuffer().then(b=>{this.result=`data:${blob.type};base64,${Buffer.from(b).toString('base64')}`;this.onloadend();});}}};
 vm.createContext(sandbox);const source=fs.readFileSync(new URL('../mobile-web/js/p2p-client.js',import.meta.url),'utf8');
 vm.runInContext(source.replace(/\bexport\s+/g,'')+'\nthis.Client=P2PClient;',sandbox);
 return new sandbox.Client({sessionId:'synthetic-session',generation:1,encryptionKeyHex:'ab'.repeat(32)});
}
for(const transport of ['webrtc','cloud'])test(`${transport}: immediate final ACK is not lost and only FILE_READY proves delivery`,async()=>{
 const client=clientFixture();const key=await webcrypto.subtle.importKey('raw',new Uint8Array(32).fill(5),'AES-GCM',false,['encrypt','decrypt']);client.cryptoKey=key;
 let packets=0;
 const ack=packet=>{packets++;if(packet.type==='CHUNK_COMPLETE'||packet.type==='TransferEnd') {
 assert.equal(typeof client.onTransferAck,'function','Waiter armed before sending completion');
 client.onTransferAck({transferId:packet.transferId,sid:client.sessionId,generation:2,status:'FILE_READY',success:true});
 assert.ok(client.onTransferAck,'Wrong generation ignored');
 client.onTransferAck({transferId:packet.transferId,sid:client.sessionId,generation:1,status:'FILE_READY',success:true});
 }};
 let result;
 if(transport==='webrtc') {client.conn={open:true,send:ack};result=await client.sendImageViaWebRTC(new Blob(['synthetic'],{type:'image/jpeg'}),{transferId:'synthetic_transfer'});}
 else{client.isCloudReady=true;client.realtimeWs={};client.relayAuth={grant:{},reserve:async()=>({reserved:true})};client.broadcast=(_event,packet)=>{ack(packet);return true};result=await client.sendImageViaCloud(new Blob(['synthetic'],{type:'image/jpeg'}),{transferId:'synthetic_transfer'});}
 assert.equal(result.status,'FILE_READY');assert.equal(result.success,true);assert.ok(packets>=3);assert.equal(client.pendingDelivery,null);assert.equal(client.onTransferAck,null);
});
test('legacy HIS_COMMITTED or implicit success ACK cannot be labeled file delivery',async()=>{
 for(const status of ['HIS_COMMITTED','SUCCESS',undefined]){
 const client=clientFixture();const waiter=client.createDeliveryWaiter('transfer01','synthetic');
 client.onTransferAck({transferId:'transfer01',sid:client.sessionId,generation:1,status,success:true});
 assert.equal((await waiter.promise).success,false);
 }
});
test('session close promptly cancels a pending ACK waiter',async()=>{
 const client=clientFixture();const waiter=client.createDeliveryWaiter('transfer01','synthetic');client.destroy();
 assert.equal((await waiter.promise).success,false);assert.equal(client.pendingDelivery,null);
});
test('new QR during asynchronous preparation sends no bytes into the replacement connection',async()=>{
 const client=clientFixture();const old={open:true,send:()=>assert.fail('Old transfer must not send')};client.conn=old;
 const promise=client.sendImageViaWebRTC(new Blob(['synthetic'],{type:'image/jpeg'}));client.sessionId='new-session';client.conn={open:true,send:()=>assert.fail('Old image must not enter new QR')};
 assert.equal((await promise).success,false);
});
test('DELIVERED receiver replays FILE_READY without assembling a duplicate',()=>{
 const context={window:{},console:{warn(){}},setTimeout,clearTimeout,Date};vm.createContext(context);
 vm.runInContext(fs.readFileSync(new URL('../extension/content/transfer-receiver.js',import.meta.url),'utf8'),context);
 const receiver=new context.window.__CamSyncTransfer.UnifiedTransferReceiver({}, {onAssembled:()=>assert.fail('Duplicate assembled')});
 const result={status:'FILE_READY',success:true};receiver.setTransferState('transfer01','DELIVERED',result);let ack;
 receiver.begin({transferId:'transfer01',v:2,totalChunks:1,totalSize:5,mimeType:'image/jpeg',sendAck:(success,_error,payload)=>ack={success,payload}});
 assert.equal(ack.success,true);assert.equal(ack.payload.status,'FILE_READY');receiver.purgeAll();
});
