// Calls into the Studio's main-process handlers through the shell's generic bridge.
/* global studioBridge */

const bridge = () => {
  if (!window.studioBridge) throw new Error('studioBridge missing (preload)');
  return window.studioBridge;
};

const call = (ch, ...args) =>
  bridge()
    .invoke(ch, ...args)
    .catch((err) => {
      // Electron prefixes "Error invoking remote method 'x': Error: ".
      throw new Error(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    });

export const api = {
  init: () => call('studio:init'),
  clips: () => call('studio:clips'),
  clipQuery: (q) => call('studio:clips:query', q),
  clipFacets: () => call('studio:clips:facets'),
  autoFill: (project, seconds) => call('studio:autoFill', project, seconds),
  projects: {
    list: () => call('studio:projects:list'),
    get: (id) => call('studio:projects:get', id),
    create: (opts) => call('studio:projects:create', opts),
    save: (p) => call('studio:projects:save', p),
    remove: (id) => call('studio:projects:delete', id),
    duplicate: (id) => call('studio:projects:duplicate', id),
  },
  style: (id) => call('studio:style', id),
  plan: (project) => call('studio:plan', project),
  render: (project, req) => call('studio:render', project, req),
  cancel: (jobId) => call('studio:render:cancel', jobId),
  music: {
    list: () => call('studio:music:list'),
    import: (files) => call('studio:music:import', files),
    analyze: (id) => call('studio:music:analyze', id),
    analyzePending: () => call('studio:music:analyzePending'),
    update: (id, patch) => call('studio:music:update', id, patch),
    remove: (id, deleteFile) => call('studio:music:remove', id, deleteFile),
    suggest: (project) => call('studio:music:suggest', project),
    aiIdeas: (project) => call('studio:music:aiIdeas', project),
  },
  ai: {
    reviewReel: (project, file, request) => call('studio:ai:reviewReel', project, file, request),
    reviseReel: (project, request, assets) => call('studio:ai:reviseReel', project, request, assets),
    status: () => call('studio:ai:status'),
    tweakStyle: (project, request) => call('studio:ai:tweakStyle', project, request),
    captions: (project, request, lines) => call('studio:ai:captions', project, request, lines),
    postCaption: (project) => call('studio:ai:postCaption', project),
    pickClips: (project, seconds) => call('studio:ai:pickClips', project, seconds),
  },
  ideas: {
    quick: (format) => call('studio:ideas:quick', format),
    ai: (format, request, count, assets) => call('studio:ideas:ai', format, request, count, assets),
    apply: (idea, request) => call('studio:ideas:apply', idea, request),
  },
  free: {
    search: (kind, q) => call('studio:free:search', kind, q),
    downloadMusic: (item) => call('studio:free:downloadMusic', item),
    downloadImage: (item) => call('studio:free:downloadImage', item),
  },
  publish: {
    status: () => call('studio:publish:status'),
    configure: (platform, cfg) => call('studio:publish:configure', platform, cfg),
    connect: (platform) => call('studio:publish:connect', platform),
    disconnect: (platform, forget) => call('studio:publish:disconnect', platform, forget),
    upload: (req) => call('studio:publish:upload', req),
  },
  assets: { pick: (kind) => call('studio:assets:pick', kind), import: (files) => call('studio:assets:import', files) },
  pickImage: () => call('studio:pickImage'),
  show: (file) => call('studio:show', file),
  open: (file) => call('studio:open', file),
  openFolder: (which) => call('studio:openFolder', which),
  exportDir: { choose: () => call('studio:exportDir:choose'), reset: () => call('studio:exportDir:reset') },
  openExternal: (url) => call('studio:openExternal', url),
  on: (ch, cb) => bridge().on(ch, cb),
};
