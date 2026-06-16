const OpenAI = require("openai");
require("dotenv").config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Detect which slice of Asana data is relevant to the question.
 */
function detectTopic(question) {
  const q = question.toLowerCase();

  const overdueKeywords   = ["overdue", "late", "past due", "missed", "behind"];
  const milestoneKeywords = ["milestone", "milestones"];
  const progressKeywords  = ["progress", "completion", "percent", "%", "how far", "how complete", "done so far", "complete"];
  const memberKeywords    = ["who", "team", "member", "assigned", "assignee", "owner", "people", "person", "working"];
  const sectionKeywords   = ["section", "column", "board", "list", "stage", "status"];
  const upcomingKeywords  = ["upcoming", "next", "due soon", "coming up", "scheduled", "what's left", "whats left", "remaining"];
  const taskKeywords      = ["task", "tasks", "open", "closed", "completed", "incomplete", "todo", "to do", "work"];

  if (overdueKeywords.some(k => q.includes(k)))   return "overdue";
  if (milestoneKeywords.some(k => q.includes(k))) return "milestones";
  if (progressKeywords.some(k => q.includes(k)))  return "progress";
  if (memberKeywords.some(k => q.includes(k)))    return "members";
  if (sectionKeywords.some(k => q.includes(k)))   return "sections";
  if (upcomingKeywords.some(k => q.includes(k)))  return "upcoming";
  if (taskKeywords.some(k => q.includes(k)))      return "tasks";

  return "all";
}

/**
 * Pick only the relevant slice of snapshot data.
 */
function sliceData(topic, snapshot) {
  switch (topic) {
    case "overdue":
      return {
        project_name:  snapshot.project.name,
        overdue_tasks: snapshot.overdue_tasks,
        summary:       snapshot.summary
      };
    case "milestones":
      return {
        project_name: snapshot.project.name,
        milestones:   snapshot.milestones
      };
    case "progress":
      return {
        project_name: snapshot.project.name,
        summary:      snapshot.summary,
        milestones:   snapshot.milestones
      };
    case "members":
      return {
        project_name: snapshot.project.name,
        owner:        snapshot.project.owner,
        members:      snapshot.project.members
      };
    case "sections":
      return {
        project_name:     snapshot.project.name,
        sections:         snapshot.sections,
        tasks_by_section: snapshot.tasks_by_section
      };
    case "upcoming":
      return {
        project_name:   snapshot.project.name,
        upcoming_tasks: snapshot.upcoming_tasks
      };
    case "tasks":
      return {
        project_name:     snapshot.project.name,
        summary:          snapshot.summary,
        upcoming_tasks:   snapshot.upcoming_tasks,
        tasks_by_section: snapshot.tasks_by_section
      };
    case "all":
    default:
      return {
        project:        snapshot.project,
        summary:        snapshot.summary,
        overdue_tasks:  snapshot.overdue_tasks,
        upcoming_tasks: snapshot.upcoming_tasks,
        milestones:     snapshot.milestones,
        sections:       snapshot.sections
      };
  }
}

/**
 * Build a visual progress bar for task completion.
 */
function buildProgressBar(summary) {
  if (!summary) return "_No progress data available._";

  const { total_tasks, completed_tasks, open_tasks, progress_pct } = summary;
  const BLOCKS = 20;
  const filled = Math.round((progress_pct / 100) * BLOCKS);
  const bar    = "█".repeat(filled) + "░".repeat(BLOCKS - filled);

  return [
    `[${bar}]  ${progress_pct}% complete`,
    `• Total:     ${total_tasks} tasks`,
    `• Done:      ${completed_tasks} tasks`,
    `• Remaining: ${open_tasks} tasks`
  ].join("\n");
}

/**
 * Main entry — routes question to right data, calls OpenAI, returns answer.
 */
async function askBrain(question, snapshot, format = "bullets") {
  const topic = detectTopic(question);
  const data  = sliceData(topic, snapshot);

  console.log(`[Brain] Topic: ${topic} | format: ${format} | data: ~${JSON.stringify(data).length} chars`);

  const formatHint = format === "paragraphs"
    ? "Write your response as clear prose paragraphs. Do NOT use bullet points or dashes. Be thorough and detailed."
    : "Use bullet points for all lists and multi-part answers. Each bullet on its own line. Be thorough and detailed.";

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_tokens: 600,
    messages: [
      {
        role: "system",
        content: `You are a helpful Asana project assistant for a Slack team.
Answer questions about the project using only the data provided.
${formatHint}
If the data doesn't contain the answer, say so honestly.
Today's date is ${new Date().toISOString().slice(0, 10)}.`
      },
      {
        role: "user",
        content: `Project data:\n${JSON.stringify(data, null, 2)}\n\nQuestion: ${question}`
      }
    ]
  });

  let answer = response.choices[0].message.content.trim();

  // Append progress bar for progress/overview questions
  if ((topic === "progress" || topic === "all") && snapshot.summary) {
    answer = `${answer}\n\n${buildProgressBar(snapshot.summary)}`;
  }

  return answer;
}

module.exports = { askBrain, buildProgressBar };
