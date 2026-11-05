import { trackFrames } from '../src/main/studio/tracking';
import { matchPortrait } from '../src/main/vision/portrait';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { ScreenFusion } from '../src/main/vision/fusion';
import { ScreenOcr } from '../src/main/vision/ocr';
import { sanitizeSettings } from '../src/main/settings';
import { StreakTracker } from '../src/main/streak';
import { upload } from '../src/main/studio/publish/tiktok';

test('late OCR trade counts the death exactly once without duplicating the settled kill', () => {
  const events: string[] = [];
  const f = new ScreenFusion({ gameEvent: key => { events.push(key); }, infoUpdate() {} }, { ocr: true, playerName: 'Ferrsir' });
  const box = { x0: 0, y0: 0, x1: 10, y1: 10 }, crop = { w: 10, h: 10, data: new Uint8Array(100) };
  f.onObservation({ kind: 'ko-line', id: 1, t: 1000, box, crop, assist: false });
  f.onObservation({ kind: 'feed-row', id: 2, t: 1050, box, crop });
  f.tick(1800);
  const result = { text: 'Enemy Ferrsir', words: [{ text: 'Enemy', x0: 0, x1: 20, conf: 90 }, { text: 'Ferrsir', x0: 60, x1: 90, conf: 90 }] };
  f.onOcr('feed', 2, result, 2100);
  f.onOcr('feed', 2, result, 2200);
  f.tick(5000);
  assert.equal(events.filter(x => x === 'kill').length, 1);
  assert.equal(events.filter(x => x === 'death').length, 1);
});

test('accepted settings reserve post-roll inside the total clip cap', () => {
  for (const postRollSeconds of [2, 5, 15]) {
    const s = sanitizeSettings({ preRollSeconds: 40, maxClipSeconds: 15, postRollSeconds });
    assert.ok(s.preRollSeconds + s.postRollSeconds <= s.maxClipSeconds);
    const tracker = new StreakTracker({ preRollMs: s.preRollSeconds * 1000, postRollMs: s.postRollSeconds * 1000, maxClipMs: s.maxClipSeconds * 1000 });
    const action = tracker.onKill(100000);
    assert.equal(action.type, 'start');
    if (action.type !== 'start') return;
    assert.ok(action.stopAt > 100000);
    assert.ok(action.stopAt - (100000 - action.pastDurationMs) <= 15000);
  }
});

test('private publishing rejects unsupported visibility before initializing any upload', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'clip.mp4'); fs.writeFileSync(file, 'fixture');
  for (const options of [[], ['PUBLIC_TO_EVERYONE'], ['MUTUAL_FOLLOW_FRIENDS']]) {
    let calls = 0;
    await assert.rejects(upload({ tiktokMode: 'direct' } as any, 'mock', file, { title: 'Test', privacy: 'private' }, () => {}, async () => {
      calls++;
      return new Response(JSON.stringify({ data: { privacy_level_options: options } }), { status: 200 });
    }), /requested privacy/);
    assert.equal(calls, 1, 'only the read-only creator query is allowed');
  }
});

test('render startup locks immediately and keeps its original project and plan key', async () => {
  let resolve!: (r: any) => void;
  let calls = 0;
  const ctx = vm.createContext({ S: { project: { id: 'a', name: 'A', format: 'reels' } },
    saveSoon: { flush() {} }, api: { render: () => { calls++; return new Promise(r => { resolve = r; }); } },
    structuredClone, planKey: () => 'plan-a', renderTop() {}, renderCenter() {}, toast() {}, root: {},
  });
  const source = fs.readFileSync(path.join(__dirname, '../../renderer/studio/index.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('async function startRender(req)'), source.indexOf('function onProgress(p)')), ctx);
  const first = ctx.startRender({ preview: true });
  ctx.S.project = { id: 'b', name: 'B', format: 'reels' };
  await ctx.startRender({ preview: true });
  assert.equal(calls, 1);
  resolve({ jobId: 'a-job' }); await first;
  assert.equal(ctx.S.job.projectId, 'a');
  assert.equal(ctx.S.job.projectName, 'A');
  assert.equal(ctx.S.job.key, 'plan-a');
});

test('OCR recognizes the known fixture, rather than merely incrementing a read counter', async t => {
  const ocr = new ScreenOcr();
  t.after(() => ocr.terminate());
  assert.equal(await ocr.init(), true, ocr.failed);
  const data = fs.readFileSync(path.join(__dirname, '../../test/fixtures/ocr-victory.gray'));
  const result = await ocr.read({ w: 320, h: 70, data }, 'light-text');
  assert.ok(result);
  assert.match(result.text, /\bVICTORY\b/i);
});

test('strict live detection rejects unreadable KOs and merges rapid OCR variants of one victim', () => {
  const events: string[] = [];
  const fusion = new ScreenFusion({ gameEvent: key => { events.push(key); }, infoUpdate() {} }, { ocr: true, strictKills: true });
  const crop = { w: 10, h: 10, data: new Uint8Array(100) }, box = { x0: 0, y0: 0, x1: 10, y1: 10 };
  for (const [id, text] of [[1, 'ilk DEADPQOOL-Easy'], [2, 'DEADPOOL-Easy'], [3, '']] as const) {
    const t = 1000 + id * 400;
    fusion.onObservation({ kind: 'ko-line', id, t, box, crop, assist: false });
    fusion.onOcr('ko', id, { text, words: text ? [{text, x0: 0, x1: 90, conf: 90}] : [] }, t + 100);
  }
  fusion.tick(8000);
  assert.equal(events.filter(k => k === 'kill').length, 1);
});

test('player-linked subtitles identify the local hero and reject other speakers', () => {
  const updates: Array<[string, unknown]> = [];
  const f = new ScreenFusion({ gameEvent() {}, infoUpdate(_feature, key, value) { updates.push([key,value]); } }, {ocr:true,playerName:'Ferrsir'});
  f.onOcr('subtitle', 1, {text:'ANGELA (OtherPlayer): Attack!',words:[]}, 1000);
  f.onOcr('subtitle', 2, {text:'MAGIK (Ferrsir): Crimson Chain!',words:[]}, 2000);
  assert.deepEqual(updates.filter(([key])=>key==='local_hero'),[['local_hero','MAGIK']]);
});


test('portrait matching rejects blank or unsupported image sizes', () => {
  const blank = {id:'portrait' as const, w:34,h:36,u:0.25,mask:new Uint8Array(1224),luma:new Uint8Array(1224)};
  assert.equal(matchPortrait(blank),undefined);
  assert.equal(matchPortrait({...blank,w:32}),undefined);
  const noise = Uint8Array.from({length:1224},(_,i)=>(i*73+31)%256);
  assert.equal(matchPortrait({...blank,luma:noise}),undefined);
});

test('Make reel preserves a long prompt, blocks duplicate starts and renders the applied plan', async () => {
  let release!: (v: unknown) => void;
  let calls = 0, received = '', renders = 0;
  const ctx = vm.createContext({S:{busy:{},ideaRequest:'Long prompt '.repeat(600),projects:[],project:{id:'old'}},
    fmt:()=>({id:'tiktok'}),renderLeft(){},renderTop(){},toast(){},root:{},saveSoon:{flush(){}},
    api:{ideas:{ai:(_f: string,p: string)=>{calls++;received=p;return new Promise(r=>release=r);},apply:async()=>({id:'new',name:'New',clips:[{}]})}},
    openProject:async()=>{ctx.S.project={id:'new',music:{trackId:'m'}};},startRender:async()=>{renders++;},
  });
  const source=fs.readFileSync(path.join(__dirname,'../../renderer/studio/index.js'),'utf8');
  vm.runInContext(source.slice(source.indexOf('async function makeReel()'),source.indexOf('function ideasPanel()')),ctx);
  const first=ctx.makeReel();await ctx.makeReel();assert.equal(calls,1);
  release([{title:'Plan',concept:'Use the triple',music:{}}]);await first;
  assert.equal(received,ctx.S.ideaRequest);assert.equal(renders,1);assert.equal(ctx.S.busy['make-reel'],false);
});

test('reel revisions cannot substitute source files and preserve the chosen music', async () => {
  const {reviseReel}=await import('../src/main/studio/ai');
  const {createProject}=await import('../src/main/studio/projects');
  const project=createProject();
  project.clips=[{uid:'one',clipId:'c',videoFile:'original.mp4',durationSec:10,width:1920,height:1080,fps:30,hasMic:false,hits:[3],in:0,out:7,useMic:false,cropX:.5,cropY:.5,cropZoom:1,kills:1,score:10,tags:[]}];
  project.music={trackId:'song',file:'song.mp3',title:'Song',start:'auto'};
  const ai={ask:async()=>({json:{clips:[{uid:'one',in:1,out:6,videoFile:'other.mp4'}],summary:'Shortened.'}})} as any;
  const result=await reviseReel(ai,project,'Shorten the clip');
  assert.equal(result.project.clips[0].videoFile,'original.mp4');
  assert.equal(result.project.clips[0].in,1);
  assert.deepEqual(result.project.music,project.music);
});


test('character crop follows a moving reference patch and holds on blank frames', () => {
  const frames: Uint8Array[]=[];
  for (let step=0;step<4;step++) {
    const frame=new Uint8Array(10000).fill(10);
    for (let y=-10;y<=10;y++) for(let x=-7;x<=7;x++) frame[(72+y)*100+43+step*2+x]=40+((x+7)*37+(y+10)*59)%200;
    frames.push(frame);
  }
  const points=trackFrames(frames,100,100,3);
  assert.ok(points.at(-1)!.x>points[0].x);
  const blank=trackFrames([new Uint8Array(10000),new Uint8Array(10000)],100,100,3);
  assert.equal(blank[0].x,blank[1].x);
});
