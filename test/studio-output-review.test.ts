import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { reviewRenderedReel } from '../src/main/studio/review';
import { createProject, reconcileProjectSources, reelClipFromSidecar, sanitizeProject } from '../src/main/studio/projects';
import type { ClipSidecar } from '../src/shared/types';

const ffmpeg=process.env.FFMPEG || 'ffmpeg';
let available=true;
try {execFileSync(ffmpeg,['-version'],{stdio:'ignore'});} catch {available=false;}

test('render review sends actual extracted frames and cannot approve a silent music mix', {skip:!available}, async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reel-review-test-'));
  try {
    const file=path.join(dir,'render.mp4');
    execFileSync(ffmpeg,['-v','error','-y','-f','lavfi','-i','color=blue:s=320x568:r=30:d=1','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','1','-c:v','libx264','-c:a','aac',file]);
    const project=createProject({styleId:'raw'});
    project.music={trackId:'song',file:'song.mp3',title:'Song',start:0};
    let called=false;
    const review=await reviewRenderedReel({ffmpeg,file,project,analysis:null,request:'No clutter',reviewDir:path.join(dir,'reviews'),ai:{
      status:async()=>({signedIn:true,provider:'codex'}),
      ask:async(opts)=>{
        called=true; assert.ok(opts.imagePaths?.length); assert.ok(opts.imagePaths!.every(f=>fs.statSync(f).size>100));
        assert.match(opts.prompt,/Measured duration 1s/);
        return {provider:'codex',text:'',json:{summary:'Looks clean in these frames.',issues:[],limits:[]}};
      },
    }});
    assert.ok(called); assert.equal(review.verdict,'needs-changes');
    assert.ok(review.issues.some(issue=>issue.includes('silent')));
    assert.ok(review.limits.some(limit=>limit.includes('Human playback')));
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('changed source metadata refreshes stale kill timing and clamps old project trims',()=>{
  const c:ClipSidecar={version:1,id:'source',videoFile:'/clips/source.mp4',durationMs:12000,createdAt:0,startTimeEpoch:1000,trigger:'auto',hero:'MAGIK',match:{},events:[{type:'kill',at:8000}],ultUsedBeforeKills:false,video:{width:2580,height:1080,fps:60},audioTracks:[],useMic:false,score:15,tags:[],scoreBreakdown:{}};
  const project=createProject();project.clips=[reelClipFromSidecar(c)];
  project.clips[0].cropX=.37;
  const changed={...c,durationMs:6000,events:[{type:'kill' as const,at:4000}]};
  const refreshed=sanitizeProject(reconcileProjectSources(project,[changed]));
  assert.equal(refreshed.clips[0].out,6);assert.deepEqual(refreshed.clips[0].hits,[3]);
  assert.equal(refreshed.clips[0].cropX,.37);assert.ok(refreshed.sourceWarnings?.length);
  assert.ok(refreshed.clips[0].sourceFingerprint);
  const missing=reconcileProjectSources(project,[]);assert.match(missing.sourceWarnings![0],/Source unavailable/);
});
