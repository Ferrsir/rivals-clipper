import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ClipSidecar } from '../src/shared/types';
import type { MusicTrack, ReelIdea } from '../src/shared/studio';
import { FORMATS } from '../src/main/studio/formats';
import { ideasPrompt, sanitizeIdeas } from '../src/main/studio/ideas';
import { projectFromIdea, sanitizeProject } from '../src/main/studio/projects';
import { plan } from '../src/main/studio/planner';
import { reviseReel } from '../src/main/studio/ai';

function clip(id='triple', hits=[2, 3.3, 6.028]): ClipSidecar {
  return {version:1,id,videoFile:`/clips/${id}.mp4`,createdAt:1000,startTimeEpoch:1000,durationMs:10028,trigger:'auto',hero:'MAGIK',match:{},events:hits.map(at=>({type:'kill',at:1000+at*1000})),ultUsedBeforeKills:false,video:{width:2580,height:1080,fps:60},audioTracks:[{index:0,label:'game'}],useMic:false,score:80,tags:['triple'],scoreBreakdown:{}};
}
const track: MusicTrack = {id:'song',file:'/music/rasputin.mp3',title:'Rasputin',addedAt:1,license:'unknown',tags:[]};
function idea(): ReelIdea {
  return {id:'plan',title:'Magik',concept:'Triple',hook:'',imageIdea:'',imageSearch:'',captions:[],styleId:'raw',format:'tiktok',clipIds:['triple'],clipEdits:[{clipId:'triple',in:1,out:8}],targetSeconds:10,music:{trackId:'song',start:42,mood:'disco',search:''},why:'',source:'ai'};
}

test('AI edit plans carry exact kill markers, source trims, duration budget and music start into a project', () => {
  const source=clip();
  const prompt=ideasPrompt({clips:[source],tracks:[track],format:FORMATS.tiktok,request:'Make a 10 second reel',count:1});
  assert.match(prompt,/"killSeconds":\[2,3.3,6.028\]/);
  const clean=sanitizeIdeas({ideas:[idea()]},[source],[track],FORMATS.tiktok)[0];
  const project=projectFromIdea(clean,[source],[track]);
  assert.equal(project.targetSeconds,10);
  assert.equal(project.music?.start,42);
  assert.equal(project.clips[0].in,1);
  assert.equal(project.clips[0].out,8);
  assert.deepEqual(project.clips[0].hits,[2,3.3,6.028]);
  assert.equal(project.clips[0].videoFile,source.videoFile);
  assert.equal(sanitizeProject(project).targetSeconds,10);
});

test('AI plans refuse trims that erase earlier kills or substitute unavailable sources', () => {
  const edit=idea();edit.clipEdits=[{clipId:'triple',in:4,out:8}];
  assert.throws(()=>projectFromIdea(edit,[clip()],[track]),/removes a marked kill/);
  edit.clipIds=['not-in-library'];
  assert.throws(()=>projectFromIdea(edit,[clip()],[track]),/unavailable/);
});

test('short duration fitting trims padding but retains every marked kill, and impossible budgets are explicit', () => {
  const project=projectFromIdea({...idea(),clipEdits:undefined},[clip()],[track]);
  const ordinary=plan({clips:project.clips,style:project.style,fps:30});
  const short=plan({clips:project.clips,style:project.style,fps:30,targetSeconds:5});
  assert.equal(short.kills.length,3);
  assert.ok(short.duration < ordinary.duration);
  assert.ok(short.duration <= 5 * 1.03 + 1/30,`Expected duration budget, got ${short.duration}`);
  // The slow 3.3 -> 6 s gap is a jump cut now, so only a 2 s budget is out of reach.
  const impossible=plan({clips:project.clips,style:project.style,fps:30,targetSeconds:2});
  assert.equal(impossible.kills.length,3);
  assert.match(impossible.warnings.join(' '),/Needs review:.*requested 2 s/);
});

test('rapid distinct kills share timing context without losing their individual markers',()=>{
  const project=projectFromIdea({...idea(),clipEdits:undefined},[clip('triple',[.366,.466,4.166])],[track]);
  const timeline=plan({clips:project.clips,style:project.style,fps:60});
  assert.equal(timeline.kills.length,3);
  assert.ok(timeline.kills[1]>timeline.kills[0]);
  assert.ok(timeline.kills[1]-timeline.kills[0]<.2);
  assert.equal(timeline.clips[0].onBeat.length,3);
});

test('AI revisions honor explicit ordering, music start and target without changing source paths', async () => {
  const project=projectFromIdea({...idea(),clipIds:['triple','single'],clipEdits:undefined},[clip(),clip('single',[3])],[track]);
  project.order='build-up';
  const [first,second]=project.clips;
  const ai={ask:async()=>({json:{clips:[{uid:second.uid},{uid:first.uid}],musicStart:51.5,targetSeconds:12,summary:'Reordered.'}})} as any;
  const result=await reviseReel(ai,project,'Swap the clips and start the music at 51.5 seconds.');
  assert.equal(result.project.order,'manual');
  assert.equal(result.project.clips[0].uid,second.uid);
  assert.equal(result.project.music?.file,track.file);
  assert.equal(result.project.music?.start,51.5);
  assert.equal(result.project.targetSeconds,12);
  const bad={ask:async()=>({json:{clips:[{uid:first.uid,in:4,out:8}]}})} as any;
  await assert.rejects(reviseReel(bad,project,'Shorten'),/cut a marked kill/);
});
