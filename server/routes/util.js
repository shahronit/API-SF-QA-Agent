'use strict';
const { repo, all, get, decode } = require('../db');
const { HttpError } = require('../http');

function getProject(id) {
  const p = repo.get('projects', id);
  if (!p) throw new HttpError(404, `Project ${id} was not found.`, { action: 'Select an existing project from the project switcher.' });
  return p;
}

function projectFrom(ctx) {
  const id = ctx.query.projectId || ctx.body.projectId || ctx.params.projectId;
  if (!id) throw new HttpError(400, 'projectId is required.', { action: 'Pass ?projectId=… or include projectId in the body.' });
  return getProject(id);
}

/**
 * Server-side pagination with whitelisted sorting and parameterised filters.
 * @param {string} table
 * @param {{where: string[], params: object, sortable: string[], defaultSort: string, columns?: string}} opts
 */
function paginate(table, ctx, { where = [], params = {}, sortable = [], defaultSort = 'rowid', defaultDir = 'DESC', columns = '*' }) {
  const page = Math.max(1, parseInt(ctx.query.page || '1', 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(ctx.query.pageSize || '25', 10) || 25));
  const sort = sortable.includes(ctx.query.sort) ? ctx.query.sort : defaultSort;
  const dir = String(ctx.query.dir || defaultDir).toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get(`SELECT COUNT(*) AS n FROM ${table} ${w}`, params).n;
  const rows = all(`SELECT ${columns} FROM ${table} ${w} ORDER BY ${sort} ${dir} LIMIT $__limit OFFSET $__offset`, { ...params, __limit: pageSize, __offset: (page - 1) * pageSize })
    .map((r) => decode(table, r));
  return { items: rows, page, pageSize, total, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** Add an IN(...) filter from a comma-separated query value. */
function inFilter(where, params, column, value, key) {
  if (!value) return;
  const vals = String(value).split(',').map((v) => v.trim()).filter(Boolean);
  if (!vals.length) return;
  const names = vals.map((v, i) => { params[`${key}${i}`] = v; return `$${key}${i}`; });
  where.push(`${column} IN (${names.join(',')})`);
}

function likeFilter(where, params, columns, q) {
  if (!q) return;
  params.__q = `%${String(q).slice(0, 100)}%`;
  where.push(`(${columns.map((c) => `${c} LIKE $__q`).join(' OR ')})`);
}

function dateRange(where, params, column, from, to) {
  if (from) { params.__from = from; where.push(`${column} >= $__from`); }
  if (to) { params.__to = to.length === 10 ? `${to}T23:59:59.999Z` : to; where.push(`${column} <= $__to`); }
}

module.exports = { getProject, projectFrom, paginate, inFilter, likeFilter, dateRange };
