const axios = require("axios");
require("dotenv").config();

const BASE    = "https://app.asana.com/api/1.0";
const headers = {
  Authorization: `Bearer ${process.env.ASANA_TOKEN}`,
  Accept: "application/json"
};

const normalise = str => str.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Find a project by name across all workspaces the token has access to.
 * Exact match first, falls back to partial match.
 */
async function findProjectByName(projectName) {
  console.log(`[Asana] Searching for project: "${projectName}"...`);
  const normalised = normalise(projectName);

  const wsRes      = await axios.get(`${BASE}/workspaces`, { headers });
  const workspaces = wsRes.data.data || [];
  if (workspaces.length === 0) throw new Error("No Asana workspaces found for this token.");

  let partialMatch = null;

  for (const ws of workspaces) {
    console.log(`[Asana] Searching workspace: "${ws.name}" (${ws.gid})`);

    const projRes = await axios.get(`${BASE}/workspaces/${ws.gid}/projects`, {
      headers,
      params: { opt_fields: "name,gid", archived: false }
    });

    for (const p of projRes.data.data || []) {
      const pName = normalise(p.name);
      if (pName === normalised) {
        console.log(`[Asana] Exact match: "${p.name}" (GID: ${p.gid})`);
        return p;
      }
      if (!partialMatch && pName.includes(normalised)) {
        partialMatch = p;
      }
    }
  }

  if (partialMatch) {
    console.log(`[Asana] Partial match: "${partialMatch.name}" (GID: ${partialMatch.gid})`);
    return partialMatch;
  }

  throw new Error(`Project "${projectName}" not found in Asana. Check spelling and try again.`);
}

/**
 * Fetch basic project details by GID.
 */
async function getProject(gid) {
  console.log(`[Asana] Fetching project (GID: ${gid})...`);
  const res = await axios.get(`${BASE}/projects/${gid}`, {
    headers,
    params: {
      opt_fields: "name,notes,current_status_update.text,due_on,start_on,completed,members.name,owner.name,permalink_url"
    }
  });
  return res.data.data;
}

/**
 * Fetch all tasks for a project (handles pagination).
 */
async function getTasks(gid) {
  console.log(`[Asana] Fetching tasks (GID: ${gid})...`);

  let tasks  = [];
  let offset = null;

  while (true) {
    const params = {
      project:    gid,
      limit:      100,
      opt_fields: "name,completed,completed_at,due_on,assignee.name,memberships.section.name,resource_subtype,notes"
    };
    if (offset) params.offset = offset;

    const res = await axios.get(`${BASE}/tasks`, { headers, params });
    tasks     = tasks.concat(res.data.data || []);

    if (res.data.next_page?.offset) {
      offset = res.data.next_page.offset;
    } else {
      break;
    }
  }

  console.log(`[Asana] Total tasks fetched: ${tasks.length}`);
  return tasks;
}

/**
 * Fetch project sections.
 */
async function getSections(gid) {
  const res = await axios.get(`${BASE}/projects/${gid}/sections`, {
    headers,
    params: { opt_fields: "name" }
  });
  return res.data.data || [];
}

/**
 * Build a full snapshot of an Asana project ready for caching.
 */
async function getAsanaSnapshot(gid) {
  const [project, tasks, sections] = await Promise.all([
    getProject(gid),
    getTasks(gid),
    getSections(gid)
  ]);

  const today        = new Date().toISOString().slice(0, 10);
  const regularTasks = tasks.filter(t => t.resource_subtype !== "milestone");
  const milestones   = tasks.filter(t => t.resource_subtype === "milestone");

  const totalTasks     = regularTasks.length;
  const completedTasks = regularTasks.filter(t => t.completed).length;
  const openTasks      = totalTasks - completedTasks;
  const progressPct    = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const overdueTasks = regularTasks
    .filter(t => !t.completed && t.due_on && t.due_on < today)
    .map(t => ({ name: t.name, due_on: t.due_on, assignee: t.assignee?.name || null }));

  const upcomingTasks = regularTasks
    .filter(t => !t.completed && t.due_on && t.due_on >= today)
    .sort((a, b) => a.due_on.localeCompare(b.due_on))
    .slice(0, 10)
    .map(t => ({ name: t.name, due_on: t.due_on, assignee: t.assignee?.name || null }));

  const tasksBySection = {};
  for (const section of sections) {
    tasksBySection[section.name] = regularTasks
      .filter(t => t.memberships?.some(m => m.section?.name === section.name))
      .map(t => ({
        name:      t.name,
        completed: t.completed,
        due_on:    t.due_on || null,
        assignee:  t.assignee?.name || null
      }));
  }

  return {
    refreshed_at:    new Date().toISOString(),
    project: {
      gid:           project.gid,
      name:          project.name,
      completed:     project.completed,
      start_on:      project.start_on,
      due_on:        project.due_on,
      permalink_url: project.permalink_url,
      status:        project.current_status_update?.text || null,
      owner:         project.owner?.name || null,
      members:       (project.members || []).map(m => m.name)
    },
    summary: {
      total_tasks:     totalTasks,
      completed_tasks: completedTasks,
      open_tasks:      openTasks,
      progress_pct:    progressPct
    },
    overdue_tasks:    overdueTasks,
    upcoming_tasks:   upcomingTasks,
    milestones:       milestones.map(t => ({
      name:      t.name,
      completed: t.completed,
      due_on:    t.due_on || null
    })),
    sections:         sections.map(s => s.name),
    tasks_by_section: tasksBySection
  };
}

module.exports = { findProjectByName, getProject, getAsanaSnapshot, normalise };
