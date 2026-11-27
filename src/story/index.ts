import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Type } from '@sinclair/typebox';
import { defineOperation, OperationError } from '../core/index.ts';
import { nameKey, requireProject } from '../library/storage.ts';
import { attachBranchScene, isManagedBranchScene, readBranch, registerBranch } from './branches.ts';
import {
  body, chapter, chapterWithScenes, characterPins, defaultLimit, draft, draftRef, draftSummary, id, itemList,
  pagination, resultLink, revision, scene, sceneDetail, sceneSummary, sourcePins, strict, title,
} from './contracts.ts';
import { branchScope, eventRefs, narrativeRef } from './narrative-contracts.ts';
import { narrativeOperations } from './narrative-operations.ts';
import { decisionOperations } from './decision-operations.ts';
import { readNarrative, sharedEventsAtFork } from './narrative-storage.ts';
import {
  assertText, chapterRows, currentDraft, currentScene, insertScene, readChapter, readDraft, readScene,
  readSceneDraft, readSceneSummary, requireRevision, sceneContext, sceneHref, sceneRows, toChapter, toDraftSummary,
  toSceneSummary, writeDraftRevision, writeSceneRevision, type ChapterRow, type DraftSummaryRow, type SceneRow,
} from './storage.ts';

export { storyDDL } from './schema.ts';
export { branchHref, readBranch } from './branches.ts';
export { eventHref, narrativeHref, projectNarrativeForGeneration, readEvent, readNarrative } from './narrative-storage.ts';
export type { Branch, Event, EventRef, Narrative, NarrativeProjectionRef, NarrativeRef, ProjectedCheckpoint } from './narrative-contracts.ts';
export type { Decision, DecisionBasis, DecisionScope, DecisionSummary, Question, QuestionSummary, StoryContext } from './decision-contracts.ts';

const sceneIdentity = { sceneId: id };
const sceneVersion = { ...sceneIdentity, revision };
const chapterIdentity = { chapterId: id };
const draftIdentity = { draftId: id };
const expectedRevision = { expectedRevision: revision };
const linkInteraction = { resultLink };
const draftInteraction = { resultLink: { ...resultLink, revisionField: 'revision' } };
const contextPins = { characters: Type.Optional(characterPins), sources: Type.Optional(sourcePins) };
const clearableDetail = Type.Optional(Type.Union([sceneDetail, Type.Null()]));

export const storyOperations = [
  defineOperation({
    id: 'chapter.create', effect: 'write', description: 'Create a chapter at the end of a project. Use project.list to find its projectId.',
    interaction: linkInteraction,
    inputSchema: Type.Object({ projectId: id, title }, strict), outputSchema: chapter,
    run({ projectId, title }, { db }) {
      assertText(title);
      requireProject(db, projectId);
      const chapterId = randomUUID();
      const cleanedTitle = title.trim();
      db.prepare(`INSERT INTO story_chapters (chapter_id, project_id, title, title_key, position)
        SELECT ?, ?, ?, ?, COALESCE(MAX(position), 0) + 1 FROM story_chapters WHERE project_id = ?`)
        .run(chapterId, projectId, cleanedTitle, nameKey(cleanedTitle), projectId);
      return readChapter(db, chapterId);
    },
  }),
  defineOperation({
    id: 'chapter.list', effect: 'read',
    description: 'List chapters in project and chapter order. Filter by projectId or exact title. Use limit and offset to page through matches.',
    inputSchema: Type.Object({ projectId: Type.Optional(id), title: Type.Optional(title), ...pagination }, strict),
    outputSchema: itemList(chapter),
    run({ projectId, title, limit = defaultLimit, offset = 0 }, { db }) {
      const conditions: string[] = [];
      const parameters: string[] = [];
      if (projectId !== undefined) {
        conditions.push('c.project_id = ?');
        parameters.push(projectId);
      }
      if (title !== undefined) {
        assertText(title);
        conditions.push('c.title_key = ?');
        parameters.push(nameKey(title));
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = db.prepare(`${chapterRows} ${where} ORDER BY c.project_id, c.position LIMIT ? OFFSET ?`)
        .all(...parameters, limit, offset) as ChapterRow[];
      return { items: rows.map(toChapter) };
    },
  }),
  defineOperation({
    id: 'chapter.read', effect: 'read',
    description: 'Read a chapter and a page of its ordered scene summaries with adopted draft references. Use scene.read for the adopted text.',
    interaction: linkInteraction,
    inputSchema: Type.Object({ ...chapterIdentity, ...pagination }, strict), outputSchema: chapterWithScenes,
    run({ chapterId, limit = defaultLimit, offset = 0 }, { db }) {
      const chapter = readChapter(db, chapterId);
      const rows = db.prepare(`${sceneRows} WHERE m.chapter_id = ? AND ${currentScene}
        ORDER BY m.position LIMIT ? OFFSET ?`).all(chapterId, limit, offset) as SceneRow[];
      return { ...chapter, scenes: rows.map(toSceneSummary) };
    },
  }),
  defineOperation({
    id: 'chapter.revise', effect: 'write', description: 'Rename a chapter using its current revision as expectedRevision.',
    interaction: linkInteraction,
    inputSchema: Type.Object({ ...chapterIdentity, ...expectedRevision, title }, strict), outputSchema: chapter,
    run({ chapterId, expectedRevision, title }, { db }) {
      assertText(title);
      const current = readChapter(db, chapterId);
      requireRevision('chapter', current.revision, expectedRevision);
      const cleanedTitle = title.trim();
      if (current.title === cleanedTitle) return current;
      db.prepare('UPDATE story_chapters SET title = ?, title_key = ?, revision = revision + 1 WHERE chapter_id = ?')
        .run(cleanedTitle, nameKey(cleanedTitle), chapterId);
      return readChapter(db, chapterId);
    },
  }),
  defineOperation({
    id: 'chapter.arrange', effect: 'write',
    description: 'Set the complete ordered list of scene IDs in a chapter using its current revision. Read all chapter.read pages first. Scenes omitted from the list become independent. A scene must be independent or already in this chapter. To move a scene, remove it from its previous chapter first.',
    interaction: linkInteraction,
    inputSchema: Type.Object({ ...chapterIdentity, ...expectedRevision, sceneIds: Type.Array(id) }, strict), outputSchema: chapter,
    run({ chapterId, expectedRevision, sceneIds }, { db }) {
      const chapter = readChapter(db, chapterId);
      requireRevision('chapter', chapter.revision, expectedRevision);
      if (new Set(sceneIds).size !== sceneIds.length) {
        throw new OperationError(400, 'chapter_duplicate_scene', 'Each scene may appear once in the chapter.');
      }
      const current = db.prepare('SELECT scene_id FROM story_chapter_scenes WHERE chapter_id = ? ORDER BY position')
        .all(chapterId) as { scene_id: string }[];
      if (current.length === sceneIds.length && current.every(({ scene_id }, index) => scene_id === sceneIds[index])) return chapter;

      const placement = db.prepare(`SELECT m.chapter_id FROM story_scenes s
        LEFT JOIN story_chapter_scenes m ON m.scene_id = s.scene_id WHERE s.scene_id = ?`);
      for (const sceneId of sceneIds) {
        const row = placement.get(sceneId);
        if (!row) throw new OperationError(404, 'scene_not_found', `Scene ${sceneId} was not found.`);
        if (isManagedBranchScene(db, sceneId)) {
          throw new OperationError(409, 'chapter_branch_scene', 'A named IF branch and its continuation scenes stay outside mainline chapters.');
        }
        if (row.chapter_id !== null && row.chapter_id !== chapterId) {
          throw new OperationError(409, 'chapter_scene_already_placed', `Scene ${sceneId} belongs to chapter ${row.chapter_id}.`);
        }
      }
      db.prepare('DELETE FROM story_chapter_scenes WHERE chapter_id = ?').run(chapterId);
      const insert = db.prepare('INSERT INTO story_chapter_scenes (scene_id, chapter_id, position) VALUES (?, ?, ?)');
      sceneIds.forEach((sceneId, index) => insert.run(sceneId, chapterId, index + 1));
      db.prepare('UPDATE story_chapters SET revision = revision + 1 WHERE chapter_id = ?').run(chapterId);
      return readChapter(db, chapterId);
    },
  }),
  defineOperation({
    id: 'scene.create', effect: 'write',
    description: 'Create an independent scene. Pin exact character revisions and source excerpts. Use chapter.arrange to place a mainline scene, or supply branchId to create an IF continuation scene.',
    interaction: linkInteraction,
    inputSchema: Type.Object({ title, time: Type.Optional(sceneDetail), place: Type.Optional(sceneDetail), branchId: Type.Optional(id), ...contextPins }, strict),
    outputSchema: scene,
    run({ title, time, place, branchId, characters = [], sources = [] }, { db }) {
      assertText(title, time, place);
      if (branchId !== undefined) readBranch(db, branchId);
      const sceneId = randomUUID();
      insertScene(db, sceneId);
      if (branchId !== undefined) attachBranchScene(db, branchId, sceneId);
      writeSceneRevision(db, sceneId, 1, { title: title.trim(), time, place, characters, sources });
      return readScene(db, sceneId);
    },
  }),
  defineOperation({
    id: 'scene.list', effect: 'read',
    description: 'List current scenes by project, chapter, exact title, origin scene (branchOf), or branchId. Use branchId null for mainline, and chapterId null for scenes without chapter placement.',
    inputSchema: Type.Object({
      projectId: Type.Optional(id), chapterId: Type.Optional(Type.Union([id, Type.Null()])), title: Type.Optional(title),
      branchOf: Type.Optional(id), branchId: Type.Optional(branchScope), ...pagination,
    }, strict), outputSchema: itemList(sceneSummary),
    run({ projectId, chapterId, title, branchOf, branchId, limit = defaultLimit, offset = 0 }, { db }) {
      if (chapterId === null && projectId !== undefined) {
        throw new OperationError(400, 'scene_invalid_placement_filter', 'Independent scenes have no project. Omit projectId with chapterId null.');
      }
      assertText(title);
      const conditions = [currentScene];
      const parameters: (string | null)[] = [];
      for (const [column, value] of [
        ['c.project_id', projectId], ['m.chapter_id', chapterId ?? undefined],
        ['r.title_key', title === undefined ? undefined : nameKey(title)], ['s.origin_scene_id', branchOf],
      ] as const) {
        if (value !== undefined) {
          conditions.push(`${column} = ?`);
          parameters.push(value);
        }
      }
      if (chapterId === null) conditions.push('m.chapter_id IS NULL');
      if (branchId !== undefined) {
        conditions.push('(CASE WHEN s.origin_scene_id IS NOT NULL THEN s.scene_id ELSE b.branch_id END) IS ?');
        parameters.push(branchId);
      }
      const rows = db.prepare(`${sceneRows} WHERE ${conditions.join(' AND ')}
        ORDER BY c.project_id NULLS LAST, c.position, m.position, s.scene_id LIMIT ? OFFSET ?`)
        .all(...parameters, limit, offset) as SceneRow[];
      return { items: rows.map(toSceneSummary) };
    },
  }),
  defineOperation({
    id: 'scene.read', effect: 'read',
    description: 'Read a scene at its latest or specified revision, including the pinned personas, source excerpts, and adopted draft text at that revision. Placement reflects the current chapter order.',
    interaction: linkInteraction,
    inputSchema: Type.Object({ ...sceneIdentity, revision: Type.Optional(revision) }, strict), outputSchema: scene,
    run({ sceneId, revision }, { db }) {
      const scene = readScene(db, sceneId, revision);
      return { ...scene, href: sceneHref(sceneId, revision) };
    },
  }),
  defineOperation({
    id: 'scene.revise', effect: 'write',
    description: 'Revise scene context using the current revision as expectedRevision. Omitted fields are preserved. Null clears time or place. A supplied characters or sources array replaces the previous pins. The adopted draft stays at its selected version.',
    interaction: linkInteraction,
    inputSchema: Type.Object({
      ...sceneIdentity, ...expectedRevision, title: Type.Optional(title), time: clearableDetail, place: clearableDetail, ...contextPins,
    }, strict), outputSchema: scene,
    run({ sceneId, expectedRevision, title, time, place, characters, sources }, { db }) {
      assertText(title, time, place);
      const current = readScene(db, sceneId);
      requireRevision('scene', current.revision, expectedRevision);
      const previous = sceneContext(current);
      const context = {
        title: title?.trim() ?? previous.title,
        time: time === undefined ? previous.time : time ?? undefined,
        place: place === undefined ? previous.place : place ?? undefined,
        characters: characters ?? previous.characters,
        sources: sources ?? previous.sources,
      };
      if (isDeepStrictEqual(context, previous)) return current;
      writeSceneRevision(db, sceneId, current.revision + 1, context, current.adopted, current.placement?.projectId);
      return readScene(db, sceneId);
    },
  }),
  defineOperation({
    id: 'scene.revisions', effect: 'read',
    description: "List a scene's revisions newest first, including the adopted draft reference at each revision. Use scene.read with a revision for the complete snapshot.",
    inputSchema: Type.Object({ ...sceneIdentity, ...pagination }, strict), outputSchema: itemList(sceneSummary),
    run({ sceneId, limit = defaultLimit, offset = 0 }, { db }) {
      readSceneSummary(db, sceneId);
      const rows = db.prepare(`${sceneRows} WHERE s.scene_id = ? ORDER BY r.revision DESC LIMIT ? OFFSET ?`)
        .all(sceneId, limit, offset) as SceneRow[];
      return { items: rows.map(toSceneSummary) };
    },
  }),
  defineOperation({
    id: 'scene.adopt', effect: 'write',
    description: "Adopt an exact candidate draft revision in a scene at the author's direction. Supply the current scene revision as expectedRevision. All candidates and their revisions remain available.",
    interaction: linkInteraction,
    inputSchema: Type.Object({ ...sceneIdentity, ...expectedRevision, draftId: id, draftRevision: revision }, strict), outputSchema: scene,
    run({ sceneId, expectedRevision, draftId, draftRevision }, { db }) {
      const current = readScene(db, sceneId);
      requireRevision('scene', current.revision, expectedRevision);
      if (current.adopted?.draftId === draftId && current.adopted.revision === draftRevision) return current;
      const selected = readSceneDraft(db, sceneId, { draftId, revision: draftRevision });
      writeSceneRevision(db, sceneId, current.revision + 1, sceneContext(current), selected, current.placement?.projectId);
      return readScene(db, sceneId);
    },
  }),
  defineOperation({
    id: 'scene.branch', effect: 'write',
    description: 'Fork an exact scene version into an IF with its own drafts. Supply branchName to name it and narrative to anchor a selected telling. With a telling, sharedEvents optionally carries forward exact events it marks as known. An explicit draft, the telling draft, or the adopted draft anchors the fork.',
    interaction: linkInteraction,
    inputSchema: Type.Object({ ...sceneVersion, divergence: sceneDetail, draft: Type.Optional(draftRef), title: Type.Optional(title),
      branchName: Type.Optional(title), narrative: Type.Optional(narrativeRef), sharedEvents: Type.Optional(eventRefs),
    }, strict),
    outputSchema: scene,
    run({ sceneId, revision, divergence, draft, title, branchName, narrative, sharedEvents }, { db }) {
      assertText(divergence, title, branchName);
      const base = readScene(db, sceneId, revision);
      const origin = narrative ? readNarrative(db, narrative.narrativeId, narrative.revision) : undefined;
      if (origin && (origin.sceneId !== sceneId || origin.sceneRevision !== revision)) {
        throw new OperationError(409, 'branch_origin_narrative_mismatch', 'Select a telling for the exact origin scene version.');
      }
      if (sharedEvents && !origin) {
        throw new OperationError(400, 'branch_origin_narrative_required', 'Pin an origin telling when sharing events.');
      }
      const shared = origin ? sharedEventsAtFork(origin, sharedEvents ?? []) : [];
      const draftPin = draft ?? origin?.draft;
      const anchor = draftPin ? readSceneDraft(db, sceneId, draftPin) : base.adopted;
      const branchId = randomUUID();
      insertScene(db, branchId, {
        sceneId, revision, divergence: divergence.trim(),
        ...(anchor === undefined ? {} : { draft: { draftId: anchor.draftId, revision: anchor.revision } }),
      });
      const context = sceneContext(base);
      if (title !== undefined) context.title = title.trim();
      writeSceneRevision(db, branchId, 1, context);
      if (branchName !== undefined || narrative !== undefined) {
        registerBranch(db, branchId, branchName?.trim() ?? context.title, narrative, shared);
      }
      return readScene(db, branchId);
    },
  }),
  defineOperation({
    id: 'draft.create', effect: 'write',
    description: 'Save a new candidate for a scene. Provide the exact sceneRevision used for its context, title, and body. Use a separate call for each telling and scene.adopt when the author chooses one.',
    interaction: draftInteraction,
    inputSchema: Type.Object({ ...sceneIdentity, sceneRevision: revision, title, body }, strict), outputSchema: draft,
    run({ sceneId, sceneRevision, title, body }, { db }) {
      assertText(title, body);
      readSceneSummary(db, sceneId, sceneRevision);
      const draftId = randomUUID();
      db.prepare('INSERT INTO story_drafts (draft_id, scene_id) VALUES (?, ?)').run(draftId, sceneId);
      writeDraftRevision(db, draftId, 1, { sceneId, sceneRevision, title: title.trim(), body });
      return readDraft(db, draftId);
    },
  }),
  defineOperation({
    id: 'draft.list', effect: 'read', description: 'List the current version of each candidate in a scene in creation order. Use draft.read for text and scene.read for the selected version.',
    inputSchema: Type.Object({ ...sceneIdentity, ...pagination }, strict), outputSchema: itemList(draftSummary),
    run({ sceneId, limit = defaultLimit, offset = 0 }, { db }) {
      readSceneSummary(db, sceneId);
      const rows = db.prepare(`SELECT r.scene_id, r.scene_revision, r.draft_id, r.revision, r.title
        FROM story_drafts d JOIN story_draft_revisions r ON r.draft_id = d.draft_id
        WHERE d.scene_id = ? AND ${currentDraft} ORDER BY d.rowid LIMIT ? OFFSET ?`)
        .all(sceneId, limit, offset) as DraftSummaryRow[];
      return { items: rows.map(toDraftSummary) };
    },
  }),
  defineOperation({
    id: 'draft.read', effect: 'read', description: "Read a candidate's current or exact revision, including its text and the sceneHref for its exact sceneRevision.",
    interaction: draftInteraction,
    inputSchema: Type.Object({ ...draftIdentity, revision: Type.Optional(revision) }, strict), outputSchema: draft,
    run: ({ draftId, revision }, { db }) => readDraft(db, draftId, revision),
  }),
  defineOperation({
    id: 'draft.revise', effect: 'write',
    description: 'Revise a candidate using its current revision as expectedRevision. Omitted fields are preserved. Specify sceneRevision only to use different scene context. Use scene.adopt separately to select the revised text.',
    interaction: draftInteraction,
    inputSchema: Type.Object({
      ...draftIdentity, ...expectedRevision, sceneRevision: Type.Optional(revision), title: Type.Optional(title), body: Type.Optional(body),
    }, strict), outputSchema: draft,
    run({ draftId, expectedRevision, sceneRevision, title, body }, { db }) {
      assertText(title, body);
      const current = readDraft(db, draftId);
      requireRevision('draft', current.revision, expectedRevision);
      const contextRevision = sceneRevision ?? current.sceneRevision;
      const revisedTitle = title?.trim() ?? current.title;
      const revisedBody = body ?? current.body;
      if (contextRevision === current.sceneRevision && revisedTitle === current.title && revisedBody === current.body) return current;
      readSceneSummary(db, current.sceneId, contextRevision);
      writeDraftRevision(db, draftId, current.revision + 1, {
        sceneId: current.sceneId, sceneRevision: contextRevision, title: revisedTitle, body: revisedBody,
      });
      return readDraft(db, draftId);
    },
  }),
  defineOperation({
    id: 'draft.revisions', effect: 'read', description: "List a candidate's revisions newest first. Use draft.read to retrieve the body of a listed revision.",
    inputSchema: Type.Object({ ...draftIdentity, ...pagination }, strict), outputSchema: itemList(draftSummary),
    run({ draftId, limit = defaultLimit, offset = 0 }, { db }) {
      if (!db.prepare('SELECT 1 FROM story_drafts WHERE draft_id = ?').get(draftId)) {
        throw new OperationError(404, 'draft_not_found', `Draft ${draftId} was not found.`);
      }
      const rows = db.prepare(`SELECT scene_id, scene_revision, draft_id, revision, title
        FROM story_draft_revisions WHERE draft_id = ? ORDER BY revision DESC LIMIT ? OFFSET ?`)
        .all(draftId, limit, offset) as DraftSummaryRow[];
      return { items: rows.map(toDraftSummary) };
    },
  }),
  defineOperation({
    id: 'draft.compare', effect: 'read',
    description: 'Return two exact draft revisions side by side for comparison. Both must belong to the specified scene. The drafts may be two versions of the same candidate.',
    inputSchema: Type.Object({ ...sceneIdentity, left: draftRef, right: draftRef }, strict),
    outputSchema: Type.Object({ left: draft, right: draft }, strict),
    run({ sceneId, left, right }, { db }) {
      readSceneSummary(db, sceneId);
      return { left: readSceneDraft(db, sceneId, left), right: readSceneDraft(db, sceneId, right) };
    },
  }),
  ...narrativeOperations,
  ...decisionOperations,
];
