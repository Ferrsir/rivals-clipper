import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {feedAlpha} from '../src/main/studio/feed-mask';
import {buildClipJob} from '../src/main/studio/render';
import {getStyle} from '../src/main/studio/styles';
import type {ReelClip} from '../src/shared/studio';

test('feed alpha retains a light row with dark names and excludes blank scenery',()=>{
  const width=400,height=100,frame=Buffer.alloc(width*height*4);
  const fill=(x0:number,y0:number,x1:number,y1:number,value:number)=>{
    for(let y=y0;y<y1;y++) for(let x=x0;x<x1;x++) {const i=(y*width+x)*4;frame[i]=frame[i+1]=frame[i+2]=value;frame[i+3]=255;}
  };
  fill(0,0,width,height,40);fill(50,20,350,42,200);fill(100,25,145,36,20);
  const alpha=feedAlpha(frame,width,height,.75);
  assert.equal(alpha[30*width+200],255);assert.equal(alpha[70*width+200],0);
  fill(0,0,width,height,240);
  assert.equal(feedAlpha(frame,width,height,.75).some(v=>v>0),false,'a bright wall is not a player feed row');
});

const ffmpeg=process.env.FFMPEG || 'ffmpeg';let available=true;
try {execFileSync(ffmpeg,['-version'],{stdio:'ignore'});}catch {available=false;}
test('transparent feed mask removes the scenery patch during a seeked and retimed render',{skip:!available},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'feed-mask-render-'));
  try {
    const source=path.join(dir,'source.mp4');
    execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','color=blue:s=1000x500:r=30:d=2','-vf','drawbox=x=840:y=12:w=160:h=45:c=green:t=fill','-an','-c:v','libx264',source]);
    const mask=path.join(dir,'mask.gray');fs.writeFileSync(mask,Buffer.alloc(400*112*60));
    const clip:ReelClip={uid:'c',clipId:'c',videoFile:source,durationSec:2,width:1000,height:500,fps:30,hasMic:false,hits:[1],in:0,out:2,useMic:false,cropX:.5,cropY:.5,cropZoom:1,kills:1,score:1,tags:[]};
    const job=buildClipJob({clip,audioCount:0,feedMask:{file:mask,width:400,height:112,fps:30},segments:[{clipUid:'c',clipIndex:0,kind:'lead',src:[.4,1.4],out:[0,.5],speed:2}],size:{width:320,height:568},fps:30,style:getStyle('raw'),preview:true,workDir:dir});
    execFileSync(ffmpeg,['-v','error','-y','-filter_complex',job.filter,...job.args]);
    const frame=execFileSync(ffmpeg,['-v','error','-ss','0.2','-i',job.output,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
    const i=(Math.round(.09*568)*320+Math.round(.78*320))*3;
    assert.ok(frame[i+2]>180 && frame[i]<50 && frame[i+1]<50,'no green scenery should be pasted into the top-right');
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
