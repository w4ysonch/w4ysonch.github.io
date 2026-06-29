'use strict';

hexo.extend.filter.register('after_render:html', function (str) {
  try {
    var cats = hexo.locals.get('categories').toArray().map(function (c) {
      return { n: c.name, p: '/' + c.path, l: c.posts.length };
    });
    var tags = hexo.locals.get('tags').toArray().map(function (t) {
      return { n: t.name, p: '/' + t.path, l: t.posts.length };
    });

    var allPosts = hexo.locals.get('posts').sort('date', -1).toArray();

    // 5 most recent posts for the right sidebar card
    var posts = allPosts.slice(0, 5).map(function (p) {
      return {
        t: p.title,
        p: '/' + p.path,
        d: p.date && p.date.format ? p.date.format('YYYY-MM-DD') : '',
        c: p.cover || null
      };
    });

    // Yearly archives
    var archiveMap = {};
    allPosts.forEach(function (p) {
      var y = p.date && typeof p.date.year === 'function'
        ? p.date.year()
        : new Date(p.date).getFullYear();
      archiveMap[y] = (archiveMap[y] || 0) + 1;
    });
    var archives = Object.keys(archiveMap)
      .map(Number)
      .sort(function (a, b) { return b - a; })
      .map(function (y) { return { y: y, l: archiveMap[y] }; });

    var script = '<script>window.__BD__=' +
      JSON.stringify({ c: cats, t: tags, p: posts, a: archives }) +
      ';<\/script>';
    return str.replace('</head>', script + '\n</head>');
  } catch (e) {
    return str;
  }
}, 10);
