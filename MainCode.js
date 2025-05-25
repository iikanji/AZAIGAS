/* ─────────────────────────────────────────────────────────────────────────────
   Arizona AI - Google Apps Script
   ───────────────────────────────────────────────────────────────────────────── */

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
const SPREADSHEET_ID = '1_pfOnIlFDOME_Ta5GO4nOYgdb_ZcSsLsjre3Diu0URc';
const TASK_MASTER_TAB = 'taskMaster';

/**
 * Serves the main HTML interface (for Arizona AI)
 */
function doGet() {
  try {
    const html = HtmlService.createTemplateFromFile('index')
      .evaluate()
      .setTitle('AEE TaskMaster II')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
    html.addMetaTag('viewport', 'width=device-width, initial-scale=1');
    html.setContent(html.getContent().replace(
      '<head>',
      `<head>\n  <base target="_top">\n  <meta http-equiv="Content-Security-Policy" content="default-src 'self' https://*.openai.com https://*.googleapis.com; script-src 'self' 'unsafe-inline' https://apis.google.com; style-src 'self' 'unsafe-inline'; connect-src 'self' https://*.googleapis.com https://api.openai.com https://script.google.com;">`
    ));
    return html;
  } catch (e) {
    return HtmlService.createHtmlOutput(`<h1>エラー</h1><p>${e.toString()}</p>`);
  }
}

/**
 * Utility to include CSS or JS files in HTML templates.
 * Usage in HTML: <?!= include('menu.css') ?>
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * Loads the chat interface template
 */
function loadChatInterface() {
  return HtmlService.createHtmlOutputFromFile('taskmasterII').getContent();
}

// ─────────────────────────────────────────────────────────────────────────────
// TaskMaster II (OpenAI Assistant) logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads the taskMaster sheet and returns all matching
 * question & model_answer pairs for the given IDs.
 * Columns: A=GradeID, B=PartID, C=LessonID, D=SectionID, E=TaskID,
 *          F=Question, G=ModelAnswer
 */
function fetchTaskInfos(grade, part, lesson, section, taskId) {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(TASK_MASTER_TAB);
  const values = sheet.getDataRange().getValues();
  values.shift(); // Remove header
  const results = values.filter(row =>
    row[0] == grade &&
    row[1] == part &&
    row[2] == lesson &&
    row[3] == section &&
    row[4] == taskId
  ).map(row => ({ question: row[5], model_answer: row[6] }));
  if (results.length === 0) throw new Error(`No tasks found for ${grade}_${part}_${lesson}_${section}_${taskId}`);
  return results;
}

/**
 * Returns assistant configuration
 */
function getAssistantConfig() {
  return {
    assistantId: PropertiesService.getScriptProperties().getProperty('OPENAI_ASSISTANT_ID'),
    welcomeMessage: 'こんにちは！AEE TaskMaster IIです。まずは Grade, Part, Lesson, Section, Task の ID を JSON 形式で教えてください。',
    model: 'gpt-4-turbo-preview',
    tools: []
  };
}

/**
 * Main chat function
 * - Detects ID payloads, fetches from Sheets,
 *   and injects all matching questions into the assistant.
 */
function sendToAssistant(message, threadId) {
  const apiKey      = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  const projectId   = PropertiesService.getScriptProperties().getProperty('OPENAI_PROJECT_ID');
  const assistantId = PropertiesService.getScriptProperties().getProperty('OPENAI_ASSISTANT_ID');
  if (!apiKey)    throw new Error('API key not set in script properties.');
  if (!projectId) throw new Error('Project ID not set in script properties.');
  if (!assistantId) throw new Error('Assistant ID not set in script properties.');
  let parsed;
  try {
    const raw = message.trim();
    const start = raw.indexOf('{');
    const end   = raw.lastIndexOf('}');
    if (start > -1 && end > start) {
      parsed = JSON.parse(raw.slice(start, end + 1));
    }
  } catch (e) {
    console.warn('Failed to parse JSON payload:', e);
  }
  if (parsed) {
    const grade   = parsed.grade     ?? parsed.gradeId;
    const part    = parsed.part      ?? parsed.partId;
    const lesson  = parsed.lesson    ?? parsed.lessonId;
    const section = parsed.section   ?? parsed.sectionId;
    const task    = parsed.task      ?? parsed.taskId;
    if (grade != null && part && lesson && section && task != null) {
      const infos = fetchTaskInfos(grade, part, lesson, section, task);
      message = JSON.stringify({ questions: infos });
    }
  }
  if (!threadId) {
    threadId = createThread(apiKey).id;
  }
  addMessageToThread(apiKey, threadId, { role: 'user', content: message });
  const runId = runAssistant(apiKey, threadId, assistantId).id;
  const assistantMsgs = waitForRunCompletion(apiKey, threadId, runId, 10, 1500);
  const last = assistantMsgs.pop();
  const reply = last?.content?.[0]?.text?.value || '（エラー：応答が取得できませんでした）';
  return { response: reply, threadId };
}

// ======================
// Helper functions
// ======================

function createThread(apiKey) {
  const resp = UrlFetchApp.fetch('https://api.openai.com/v1/threads', {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'OpenAI-Beta': 'assistants=v2',
      'Content-Type': 'application/json'
    }
  });
  return JSON.parse(resp.getContentText());
}

function addMessageToThread(apiKey, threadId, message) {
  UrlFetchApp.fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'OpenAI-Beta': 'assistants=v2',
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify(message)
  });
}

function runAssistant(apiKey, threadId, assistantId) {
  const resp = UrlFetchApp.fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'OpenAI-Beta': 'assistants=v2',
      'Content-Type': 'application/json'
    },
    payload: JSON.stringify({ assistant_id: assistantId })
  });
  return JSON.parse(resp.getContentText());
}

function waitForRunCompletion(apiKey, threadId, runId, maxAttempts, delay) {
  for (let i = 0; i < maxAttempts; i++) {
    Utilities.sleep(delay);
    const status = getRunStatus(apiKey, threadId, runId).status;
    if (status === 'completed') {
      return listThreadMessages(apiKey, threadId);
    } else if (status === 'failed') {
      throw new Error('Run failed');
    }
  }
  throw new Error('Assistant is busy. Try again later.');
}

function getRunStatus(apiKey, threadId, runId) {
  const resp = UrlFetchApp.fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'OpenAI-Beta': 'assistants=v2' }
  });
  return JSON.parse(resp.getContentText());
}

function listThreadMessages(apiKey, threadId) {
  const resp = UrlFetchApp.fetch(`https://api.openai.com/v1/threads/${threadId}/messages?order=asc`, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'OpenAI-Beta': 'assistants=v2' }
  });
  return JSON.parse(resp.getContentText()).data.filter(m => m.role === 'assistant');
}

function initializeProperties() {
  PropertiesService.getScriptProperties().setProperties({
    OPENAI_API_KEY:      'your-api-key-here',
    OPENAI_PROJECT_ID:   'proj_XXXXXXXXXXXX',
    OPENAI_ASSISTANT_ID: 'asst_gIbymFI6r5EtNKXLC5yleH7C'
  });
}

function setProjectId() {
  PropertiesService.getScriptProperties().setProperty('OPENAI_PROJECT_ID', 'proj_XXXXXXXXXXXX');
}

/**
 * Returns vocabulary quiz data for a given grade.
 * Reads the 'VocabQuiz' tab in the spreadsheet.
 * Each row: Grade | Problem | Answers (comma-separated) | Hint
 */
function getQuizData(grade) {
  if (!grade) throw new Error("Missing grade in getQuizData call.");
  let sheetName;
  if (grade === '5') sheetName = 'systan5';
  else if (grade === '4') sheetName = 'systan4';
  else throw new Error('Unsupported grade level: ' + grade);

  const cache = CacheService.getScriptCache();
  const lock = LockService.getScriptLock();
  const cacheKey = `VOCAB_QUIZ_GRADE_${grade}`;
  let raw = cache.get(cacheKey);
  if (!raw) {
    lock.waitLock(5000);
    try {
      raw = cache.get(cacheKey);
      if (!raw) {
        const sheetId = PropertiesService.getScriptProperties().getProperty('LESSON_TARGETS_ID');
        if (!sheetId) throw new Error('Missing LESSON_TARGETS_ID');
        const ss = SpreadsheetApp.openById(sheetId);
        const sheet = ss.getSheetByName(sheetName);
        if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
        const data = sheet.getDataRange().getValues();
        const today = new Date();
        const currentDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        function getWeekStart(d) {
          const day = new Date(d);
          const diff = (day.getDay() + 6) % 7;
          day.setDate(day.getDate() - diff);
          day.setHours(0, 0, 0, 0);
          return day;
        }
        const thisWeekStart = getWeekStart(currentDay);
        const thisWeekEnd = new Date(thisWeekStart);
        thisWeekEnd.setDate(thisWeekStart.getDate() + 7);
        const lastWeekStart = new Date(thisWeekStart);
        lastWeekStart.setDate(thisWeekStart.getDate() - 7);
        const lastWeekEnd = new Date(thisWeekStart);
        const thisWeek = [], lastWeek = [];
        for (let i = 1; i < data.length; i++) {
          const row = data[i];
          const rawDate = row[0]; if (!rawDate) continue;
          const rowDate = new Date(rawDate);
          if (isNaN(rowDate)) continue;
          rowDate.setHours(0, 0, 0, 0);
          const t = rowDate.getTime();
          let bucket = null;
          if (t >= thisWeekStart.getTime() && t < thisWeekEnd.getTime()) bucket = thisWeek;
          else if (t >= lastWeekStart.getTime() && t < lastWeekEnd.getTime()) bucket = lastWeek;
          if (bucket && row[3] && row[3].includes('[blank]') && row[5]) {
            bucket.push({ hint: row[2]||'', problem: row[3], answers: row[5].toString().split(',').map(a=>a.trim()) });
          }
        }
        const shuffle = arr => arr.map(v=>[Math.random(),v]).sort((a,b)=>a[0]-b[0]).map(v=>v[1]);
        const ordered = shuffle([...thisWeek, ...lastWeek]);
        if (!ordered.length) throw new Error("No valid quiz data.");
        cache.put(cacheKey, JSON.stringify(ordered), 300);
        raw = JSON.stringify(ordered);
      }
    } finally {
      lock.releaseLock();
    }
  }
  return JSON.parse(raw);
}

