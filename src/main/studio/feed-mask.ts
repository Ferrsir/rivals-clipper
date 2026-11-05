import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { feedCandidates } from '../vision/detectors';
import { makeView } from '../vision/image';
import type { HudLayout, RegionGeom } from '../vision/layout';
import type { ReelClip } from '../../shared/studio';

export interface FeedMask {file:string;width:number;height:number;fps:number}

/** Retain detected light player-feed rows and make surrounding scenery transparent. */
export function feedAlpha(bgra:Uint8Array,width:number,height:number,units:number):Uint8Array {
  const view=makeView(bgra,{mosaicW:width} as HudLayout,{id:'feed',outW:width,outH:height,outY:0,pxPerUnit:units} as RegionGeom);
  const alpha=new Uint8Array(width*height);
  for(const {box} of feedCandidates(view)) {
    const x0=Math.max(0,Math.floor(box.x0-60*units)),x1=width;
    const y0=Math.max(0,box.y0-2),y1=Math.min(height,box.y1+2);
    for(let y=y0;y<y1;y++) alpha.fill(255,y*width+x0,y*width+x1);
  }
  return alpha;
}

export async function createFeedMask(ffmpeg:string,clip:ReelClip,cache:string,signal?:AbortSignal):Promise<FeedMask|undefined> {
  // Bound memory even for legacy/imported long sources, which retain the normal feed crop.
  if(clip.durationSec>30 || !clip.width || !clip.height) return undefined;
  const nativeW=Math.floor(clip.width*.16/2)*2,nativeH=Math.floor(clip.height*.09/2)*2;
  const width=Math.min(400,Math.max(2,nativeW));
  const height=Math.round(nativeH/nativeW*width/2)*2,fps=30;
  const stat=fs.statSync(clip.videoFile);
  const key=crypto.createHash('sha256').update(JSON.stringify([clip.videoFile,stat.size,stat.mtimeMs,clip.durationSec,width,height,'feed-alpha-v2'])).digest('hex').slice(0,20);
  const file=path.join(cache,`feed-alpha-${key}.gray`);
  if(fs.existsSync(file)) return {file,width,height,fps};
  const data=await new Promise<Buffer>((resolve,reject)=>execFile(ffmpeg,['-v','error','-i',clip.videoFile,'-t',String(clip.durationSec),'-vf',`crop=w=trunc(iw*0.16/2)*2:h=trunc(ih*0.09/2)*2:x=iw-ow:y=trunc(ih*0.025/2)*2,scale=${width}:${height},fps=${fps}`,'-an','-pix_fmt','bgra','-f','rawvideo','pipe:1'],
    {encoding:'buffer',windowsHide:true,timeout:60000,maxBuffer:192*1024*1024,signal},(error,stdout)=>error?reject(error):resolve(stdout)));
  const size=width*height*4,frames=Math.floor(data.length/size);
  if(!frames) throw new Error('Could not read the source kill-feed frames.');
  fs.mkdirSync(cache,{recursive:true});
  const partial=file+'.part';const fd=fs.openSync(partial,'w');
  try {
    for(let i=0;i<frames;i++) {
      if(signal?.aborted) throw new Error('cancelled');
      fs.writeSync(fd,feedAlpha(data.subarray(i*size,(i+1)*size),width,height,clip.height/1440*width/nativeW));
    }
  } catch(error) {fs.closeSync(fd);fs.rmSync(partial,{force:true});throw error;}
  fs.closeSync(fd);fs.renameSync(partial,file);
  return {file,width,height,fps};
}
