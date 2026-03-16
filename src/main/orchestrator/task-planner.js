// ═══════════════════════════════════════════════════════════════
// TASK PLANNER — decomposes user prompt into subtasks, assigns to agents
// ═══════════════════════════════════════════════════════════════

class TaskPlanner {
  constructor(registry, messageBus) {
    this.registry = registry;
    this.messageBus = messageBus;
    this.activePlan = null; // current plan being executed
  }

  // Create a plan: leader decomposes, builders get assigned
  createPlan(userPrompt, leaderAgent, builderAgents) {
    const plan = {
      id: `plan_${Date.now()}`,
      userPrompt,
      leaderId: leaderAgent.id,
      leaderName: leaderAgent.displayName || leaderAgent.name,
      status: 'pending', // pending → planning → executing → reporting → done
      subtasks: [],
      createdAt: new Date().toISOString(),
    };
    // Pre-assign builders
    builderAgents.forEach((b, i) => {
      plan.subtasks.push({
        id: `subtask_${i}`,
        assignee: b.id,
        assigneeName: b.displayName || b.name,
        description: '',
        targetFiles: [],
        status: 'waiting', // waiting → running → done → reviewed → integrated
        reviewStatus: 'pending', // pending → reviewing → approved → rejected
        summary: '',
        reviewNotes: '',
      });
    });
    this.activePlan = plan;
    return plan;
  }

  // Parse leader's decomposition output into subtasks
  parseLeaderOutput(text, plan) {
    // Try to find JSON task list in output
    // Match outermost JSON array (greedy to handle nested arrays)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const tasks = JSON.parse(jsonMatch[0]);
        tasks.forEach((t, i) => {
          if (plan.subtasks[i]) {
            plan.subtasks[i].description = t.task || t.description || t;
            if (t.files) plan.subtasks[i].targetFiles = Array.isArray(t.files) ? t.files : [t.files];
          }
        });
        return plan.subtasks;
      } catch {}
    }

    // Fallback: split by numbered list or bullet points
    const lines = text.split('\n')
      .map(l => l.replace(/^\s*[-*•]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
      .filter(l => l.length > 5 && !l.startsWith('#'));

    lines.forEach((line, i) => {
      if (plan.subtasks[i]) {
        plan.subtasks[i].description = line;
      }
    });

    // If not enough subtasks parsed, give remaining builders the full prompt
    plan.subtasks.forEach(st => {
      if (!st.description) st.description = plan.userPrompt;
    });

    return plan.subtasks;
  }

  // Build the leader's planning prompt
  buildPlanningPrompt(userPrompt, builderNames) {
    return `You are the LEADER SCV. Your job is to decompose a task into subtasks for your team.

## Team builders available
${builderNames.map((n, i) => `${i + 1}. ${n}`).join('\n')}

## User request
${userPrompt}

## Instructions
- Decompose this into ${builderNames.length} parallel subtasks, one per builder
- Each subtask should be independent (no dependencies between them)
- Output a JSON array with "task" and "files" fields:
[{"task": "subtask description", "files": ["file1.js"]}, {"task": "subtask 2", "files": ["file2.js"]}]
- Be specific about what each builder should do
- Assign different files to different builders (no overlap)
- Keep subtasks roughly equal in size`;
  }

  // Build the final report prompt for leader
  buildReportPrompt(plan) {
    let ctx = `You are the LEADER SCV. Your builders have completed their subtasks.\n\n`;
    ctx += `## Original request\n${plan.userPrompt}\n\n`;
    ctx += `## Builder results\n`;
    plan.subtasks.forEach(st => {
      ctx += `### ${st.assigneeName}\n`;
      ctx += `Task: ${st.description}\n`;
      ctx += `Status: ${st.status}\n`;
      ctx += `Summary: ${st.summary || '(no summary)'}\n\n`;
    });
    ctx += `## Instructions\n`;
    ctx += `- Summarize what was accomplished\n`;
    ctx += `- Note any issues or incomplete work\n`;
    ctx += `- Give a final status report to the user\n`;
    return ctx;
  }

  // Mark a subtask as complete
  completeSubtask(plan, agentId, summary) {
    const st = plan.subtasks.find(s => String(s.assignee) === String(agentId));
    if (st) {
      st.status = 'done';
      st.summary = summary;
    }
    // Check if all subtasks done
    const allDone = plan.subtasks.every(s => s.status === 'done' || s.status === 'failed');
    if (allDone) plan.status = 'reporting';
    return allDone;
  }

  markSubtaskFailed(plan, agentId, error) {
    const st = plan.subtasks.find(s => String(s.assignee) === String(agentId));
    if (st) {
      st.status = 'failed';
      st.summary = `FAILED: ${error}`;
    }
    const allDone = plan.subtasks.every(s => s.status === 'done' || s.status === 'failed');
    if (allDone) plan.status = 'reporting';
    return allDone;
  }
}

module.exports = { TaskPlanner };
