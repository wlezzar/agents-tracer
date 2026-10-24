import { describe, expect, it } from 'vitest';

import type { ViewProject } from '../../view/types.js';
import { jumpTarget, projectsMatching, sessionsById } from './projectSearch.js';

function project(id: string, cwd: string | null, sessions: readonly (readonly [string, number])[]): ViewProject {
  return {
    id,
    cwd,
    href: `/p/${id}`,
    sessions: sessions.map(([sid, modified]) => ({
      id: sid,
      size: 1024,
      modified,
      href: `/p/${id}/s/${sid}`,
      conversationHref: `/p/${id}/s/${sid}/conversation`,
    })),
  };
}

const shop = project('-home-dev-shop', '/home/dev/shop', [
  ['5e1f0c2a', 30],
  ['5e9b7c6d', 10],
]);
const blog = project('-home-dev-blog', '/home/dev/blog', [
  ['7a3c9e1f', 40],
  ['5e2a0b1c', 20],
]);
const bare = project('-home-dev-tools', null, [['c3d4e5f6', 5]]);
const projects = [shop, blog, bare];

describe('sessionsById', () => {
  it('finds the sessions whose id starts with the query, whatever its case and spaces, newest first, with their project', () => {
    expect(sessionsById(projects, ' 5E ').map((f) => [f.session.id, f.project.id])).toEqual([
      ['5e1f0c2a', shop.id],
      ['5e2a0b1c', blog.id],
      ['5e9b7c6d', shop.id],
    ]);
  });

  it('finds none for an empty query, or for one inside an id that does not start it', () => {
    expect(sessionsById(projects, ' ')).toEqual([]);
    expect(sessionsById(projects, '0c2a')).toEqual([]);
  });
});

describe('projectsMatching', () => {
  it('keeps the projects whose directory or id holds the query, whatever its case', () => {
    expect(projectsMatching(projects, 'BLOG').map((p) => p.id)).toEqual([blog.id]);
    expect(projectsMatching(projects, 'dev/').map((p) => p.id)).toEqual([shop.id, blog.id]);
    expect(projectsMatching(projects, '-tools').map((p) => p.id)).toEqual([bare.id]);
  });

  it('keeps every project for an empty query, and none for one nothing holds', () => {
    expect(projectsMatching(projects, ' ')).toEqual(projects);
    expect(projectsMatching(projects, 'zz')).toEqual([]);
  });
});

describe('jumpTarget', () => {
  it('is the conversation of the only session whose id starts with the query', () => {
    expect(jumpTarget(projects, '5E1F')).toBe('/p/-home-dev-shop/s/5e1f0c2a/conversation');
  });

  it('is the only project that matches, when no single session does', () => {
    expect(jumpTarget(projects, 'blog')).toBe('/p/-home-dev-blog');
    expect(jumpTarget([shop], '')).toBe('/p/-home-dev-shop');
  });

  it('is nowhere when several sessions or projects match, or none does', () => {
    for (const query of ['5e', 'home', 'zz', '']) expect(jumpTarget(projects, query)).toBeNull();
  });

  it('is nowhere for the only session or project when the server cannot open it', () => {
    const unlinked: ViewProject = {
      ...bare,
      href: null,
      sessions: bare.sessions.map((s) => ({ ...s, href: null, conversationHref: null })),
    };
    expect(jumpTarget([shop, unlinked], 'c3d4')).toBeNull();
    expect(jumpTarget([shop, unlinked], 'tools')).toBeNull();
  });
});
