/* custom-layout.js
 * Strategy:
 *   Left column  → #aside-content kept in place, made sticky via CSS.
 *                  All Butterfly CSS applies natively; no DOM moving needed.
 *   Right column → .right-sticky-col built from window.__BD__ (recent posts + archives).
 *   Post pages   → Inject category/tag cards INTO #aside-content so they
 *                  inherit Butterfly's native aside styling automatically.
 */
(function () {
  'use strict';

  function isPostPage() {
    return !!document.querySelector('#body-wrap.post');
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------- right column card builders ---------- */

  function buildRecentPostsCard(posts) {
    var items = posts.map(function (p) {
      var thumb = p.c
        ? '<a class="thumbnail" href="' + esc(p.p) + '" title="' + esc(p.t) + '">' +
          '<img src="' + esc(p.c) + '" alt="' + esc(p.t) + '"></a>'
        : '';
      return '<div class="aside-list-item' + (p.c ? '' : ' no-cover') + '">' +
        thumb +
        '<div class="content">' +
        '<a class="title" href="' + esc(p.p) + '" title="' + esc(p.t) + '">' + esc(p.t) + '</a>' +
        '<time>' + esc(p.d) + '</time>' +
        '</div></div>';
    }).join('');
    return '<div class="card-widget card-recent-post">' +
      '<div class="item-headline"><i class="fas fa-history"></i><span>最新文章</span></div>' +
      '<div class="aside-list">' + items + '</div>' +
      '</div>';
  }

  function buildArchivesCard(archives) {
    var items = archives.map(function (a) {
      return '<li class="card-archive-list-item">' +
        '<a class="card-archive-list-link" href="/archives/' + a.y + '/">' +
        '<span class="card-archive-list-date">' + a.y + '</span>' +
        '<span class="card-archive-list-count">' + a.l + '</span>' +
        '</a></li>';
    }).join('');
    return '<div class="card-widget card-archives">' +
      '<div class="item-headline"><i class="fas fa-archive"></i><span>归档</span></div>' +
      '<ul class="card-archive-list">' + items + '</ul>' +
      '</div>';
  }

  /* ---------- left column injectors (post pages only) ---------- */

  function buildCatHtml(cats) {
    var items = cats.map(function (c) {
      return '<li class="card-category-list-item">' +
        '<a class="card-category-list-link" href="' + esc(c.p) + '">' +
        '<span class="card-category-list-name">' + esc(c.n) + '</span>' +
        '<span class="card-category-list-count">' + c.l + '</span>' +
        '</a></li>';
    }).join('');
    return '<div class="card-widget card-categories">' +
      '<div class="item-headline"><i class="fas fa-folder-open"></i><span>分类</span></div>' +
      '<ul class="card-category-list">' + items + '</ul>' +
      '</div>';
  }

  function buildTagHtml(tags) {
    var items = tags.map(function (t) {
      return '<a href="' + esc(t.p) + '">' + esc(t.n) + '</a>';
    }).join('');
    return '<div class="card-widget card-tags">' +
      '<div class="item-headline"><i class="fas fa-tags"></i><span>标签</span></div>' +
      '<div class="card-tag-cloud injected-tags">' + items + '</div>' +
      '</div>';
  }

  /* ---------- main ---------- */

  function buildLayout() {
    if (window.innerWidth < 1200) return;

    var grid = document.querySelector('#content-inner.layout');
    if (!grid) return;

    // Remove stale right column from previous PJAX navigation
    var prev = grid.querySelector('.right-sticky-col');
    if (prev) prev.remove();

    var bd = window.__BD__;
    if (!bd) return;

    // Build right column from server-injected data
    var rightCol = document.createElement('div');
    rightCol.className = 'right-sticky-col';

    if (bd.p && bd.p.length) {
      rightCol.insertAdjacentHTML('beforeend', buildRecentPostsCard(bd.p));
    }
    if (bd.a && bd.a.length) {
      rightCol.insertAdjacentHTML('beforeend', buildArchivesCard(bd.a));
    }

    if (rightCol.children.length) {
      grid.appendChild(rightCol);
    }

    // On post pages: inject category/tag cards into #aside-content.
    // They land inside #aside-content, so Butterfly's card CSS applies natively.
    if (isPostPage()) {
      var aside = document.querySelector('#aside-content');
      if (aside) {
        if (bd.c && bd.c.length && !aside.querySelector('.card-categories')) {
          aside.insertAdjacentHTML('beforeend', buildCatHtml(bd.c));
        }
        if (bd.t && bd.t.length && !aside.querySelector('.card-tags')) {
          aside.insertAdjacentHTML('beforeend', buildTagHtml(bd.t));
        }
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildLayout);
  } else {
    buildLayout();
  }
  document.addEventListener('pjax:complete', buildLayout);
})();
