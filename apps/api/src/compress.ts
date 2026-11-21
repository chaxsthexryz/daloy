/**
 * Shrinks photos on the visitor's phone before they upload (R5, decision 0092), so a 6 MB camera photo of a receipt
 * is not refused for size and costs less mobile data. Served at /public/compress.js so the page's script-src 'self'
 * holds. It only ever swaps a chosen JPEG, PNG or WebP for a smaller JPEG: anything it cannot read, or cannot make
 * smaller, goes up unchanged. The server does not trust it. It still checks the real type from the bytes and the size
 * limit (N21), so a visitor without the script, or one who edits it, gets the same checks.
 * Limits: the longest side is at most 2000 px, JPEG quality 0.8, and files of 300 KB or less that already fit are left alone.
 */
export const COMPRESS_JS = `(function(){
var MAX=2000,Q=0.8,SKIP=300*1024,OK=/^image\\/(jpeg|png|webp)$/;
function squeeze(f){
if(!OK.test(f.type)||typeof createImageBitmap!=="function")return Promise.resolve(f);
return createImageBitmap(f).then(function(img){
var s=Math.min(1,MAX/Math.max(img.width,img.height));
if(s===1&&f.size<=SKIP){if(img.close)img.close();return f}
var c=document.createElement("canvas");c.width=Math.max(1,Math.round(img.width*s));c.height=Math.max(1,Math.round(img.height*s));
var x=c.getContext("2d");x.fillStyle="#fff";x.fillRect(0,0,c.width,c.height);x.drawImage(img,0,0,c.width,c.height);if(img.close)img.close();
return new Promise(function(done){c.toBlob(function(b){done(b&&b.size<f.size?new File([b],f.name.replace(/\\.[^.]+$/,"")+".jpg",{type:"image/jpeg"}):f)},"image/jpeg",Q)})
}).catch(function(){return f})}
function wire(inp){inp.addEventListener("change",function(){
var files=Array.prototype.slice.call(inp.files||[]);
if(!files.length)return;
var btns=inp.form?Array.prototype.slice.call(inp.form.querySelectorAll("button[type=submit]")):[];
btns.forEach(function(b){b.disabled=true});
Promise.all(files.map(squeeze)).then(function(out){
if(out.every(function(f,i){return f===files[i]}))return;
var dt=new DataTransfer();out.forEach(function(f){dt.items.add(f)});inp.files=dt.files}).catch(function(){}).then(function(){btns.forEach(function(b){b.disabled=false})})})}
Array.prototype.forEach.call(document.querySelectorAll("input[type=file]"),wire)})();
`;

/** Added after a form that takes photos. Without the script the form works the same, with the original files. */
export const COMPRESS_TAG = '<script src="/public/compress.js" defer></script>';
