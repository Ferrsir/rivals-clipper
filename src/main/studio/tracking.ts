import { execFile } from 'node:child_process';
import type { ReelClip } from '../../shared/studio';
export interface TrackPoint { t: number; x: number }
/** Follow a player-centred patch between nearby frames. Low-confidence frames hold the prior position. */
export function trackFrames(frames: Uint8Array[], width: number, height: number, fps: number): TrackPoint[] {
  if (!frames.length) return [];
  const radiusX=7, radiusY=10;
  let x=Math.round(width*0.43), y=Math.round(height*0.72);
  const patch=(frame:Uint8Array,cx:number,cy:number)=>{
    const values:number[]=[];
    for(let dy=-radiusY;dy<=radiusY;dy++)for(let dx=-radiusX;dx<=radiusX;dx++)values.push(frame[(cy+dy)*width+cx+dx]);
    const mean=values.reduce((a,b)=>a+b,0)/values.length;
    const spread=Math.sqrt(values.reduce((sum,v)=>sum+(v-mean)**2,0)/values.length);
    return {values:values.map(v=>(v-mean)/Math.max(8,spread)),spread};
  };
  let reference=patch(frames[0],x,y);
  const points:TrackPoint[]=[{t:0,x:x/width}];
  for(let i=1;i<frames.length;i++){
    let best=Infinity,bx=x,by=y;
    for(let cy=Math.max(radiusY,y-4);cy<=Math.min(height-radiusY-1,y+4);cy+=2){
      for(let cx=Math.max(radiusX,Math.round(width*0.25),x-10);cx<=Math.min(width-radiusX-1,Math.round(width*0.65),x+10);cx+=2){
        const candidate=patch(frames[i],cx,cy);
        if(candidate.spread<10||reference.spread<10)continue;
        const distance=candidate.values.reduce((sum,v,j)=>sum+Math.abs(v-reference.values[j]),0)/candidate.values.length;
        if(distance<best){best=distance;bx=cx;by=cy;}
      }
    }
    if(best<0.45){x=bx;y=by;reference=patch(frames[i],x,y);}
    points.push({t:i/fps,x:x/width});
  }
  return points;
}
export function trackClip(ffmpeg:string,clip:ReelClip,signal?:AbortSignal):Promise<TrackPoint[]>{
  const width=192,height=Math.max(32,Math.round(width*clip.height/clip.width/2)*2);
  return new Promise((resolve,reject)=>{
    execFile(ffmpeg,['-v','error','-i',clip.videoFile,'-t',String(Math.min(300,clip.durationSec)),'-vf',`fps=3,scale=${width}:${height},format=gray`,'-an','-f','rawvideo','pipe:1'],{encoding:'buffer',maxBuffer:64*1024*1024,timeout:60000,windowsHide:true,signal},(error,stdout)=>{
      if(error)return signal?.aborted?reject(new Error('cancelled')):resolve([]);
      const size=width*height,frames:Uint8Array[]=[];
      for(let offset=0;offset+size<=stdout.length;offset+=size)frames.push(stdout.subarray(offset,offset+size));
      resolve(trackFrames(frames,width,height,3));
    });
  });
}
