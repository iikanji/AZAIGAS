/* ─────────────────────────────────────────────────────────────────────────────
   AEE TaskMaster II - Google Apps Script
   ───────────────────────────────────────────────────────────────────────────── */

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
// Using SPREADSHEET_ID and TASK_MASTER_TAB from MainCode.js

/**
 * Reads the taskMaster sheet and returns all matching
 * question & model_answer pairs for the given IDs.
 * Columns: A=GradeID, B=PartID, C=LessonID, D=SectionID, E=TaskID,
 *          F=Question, G=ModelAnswer
 */
/**
 * Fetches all entries matching the given IDs, returning
 * { question, model_answer, target_pattern, notes } for each.
 */
function fetchTaskInfos(grade, subject, lessonUnit, section, taskOption) {
  const values = SpreadsheetApp
    .openById(SPREADSHEET_ID)
    .getSheetByName(TASK_MASTER_TAB)
    .getDataRange()
    .getValues();

  const [, ...rows] = values;

  Logger.log('Looking for:');
  Logger.log({
    grade: String(grade).trim(),
    subject: String(subject).trim(),
    lessonUnit: String(lessonUnit).trim(),
    section: String(section).trim(),
    taskOption: String(taskOption).trim()
  });

  const results = rows.reduce((acc, r, idx) => {
    const rowObj = {
      grade: String(r[0]).trim(),
      subject: String(r[1]).trim(),
      lessonUnit: String(r[2]).trim(),
      section: String(r[3]).trim(),
      taskOption: String(r[4]).trim()
    };
    Logger.log(`Row ${idx + 2}: ${JSON.stringify(rowObj)}`);
    if (
      rowObj.grade === String(grade).trim() &&
      rowObj.subject === String(subject).trim() &&
      rowObj.lessonUnit === String(lessonUnit).trim() &&
      rowObj.section === String(section).trim() &&
      rowObj.taskOption === String(taskOption).trim()
    ) {
      Logger.log(`Matched row ${idx + 2}`);
      acc.push({
        question:       '\n' + r[5], // Column F
        model_answer:   r[6], // Column G
        target_pattern: r[7], // Column H
        notes:          r[8]  // Column I
      });
    }
    return acc;
  }, []);

  if (results.length === 0) {
    Logger.log(`No tasks found for ${grade}_${subject}_${lessonUnit}_${section}_${taskOption}`);
    throw new Error(`No tasks found for ${grade}_${subject}_${lessonUnit}_${section}_${taskOption}`);
  }
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
function sendToAssistant(message, threadId, assistantId, projectId) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!apiKey) throw new Error('API key not set in script properties.');
  if (!projectId) throw new Error('Project ID not set in menu.');
  if (!assistantId) throw new Error('Assistant ID not set in menu.');

  // Extract JSON payload
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
    const grade      = parsed.grade      ?? parsed.gradeId;
    const subject    = parsed.subject    ?? parsed.subjectId;
    const lessonUnit = parsed['Lesson/Unit'] ?? parsed.lessonUnit ?? parsed.lessonId;
    const section    = parsed.section    ?? parsed.sectionId;
    const taskOption = parsed['Task/Option'] ?? parsed.taskOption ?? parsed.taskId;

    if (grade != null && subject && lessonUnit && section && taskOption != null) {
      // Fetch matching question/model_answer pairs
      const infos = fetchTaskInfos(grade, subject, lessonUnit, section, taskOption);
      // Inject as structured payload
      message = JSON.stringify({ questions: infos });
    }
  }

  // 1. Create or reuse thread
  if (!threadId) {
    // Pass projectId in header
    const threadResp = UrlFetchApp.fetch('https://api.openai.com/v1/threads', {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'OpenAI-Beta': 'assistants=v2',
        'Content-Type': 'application/json',
        'OpenAI-Project': projectId
      }
    });
    threadId = JSON.parse(threadResp.getContentText()).id;
  }

  // 2. Add user message
  UrlFetchApp.fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'OpenAI-Beta': 'assistants=v2',
      'Content-Type': 'application/json',
      'OpenAI-Project': projectId
    },
    payload: JSON.stringify({ role: 'user', content: message })
  });

  // 3. Run assistant
  const runResp = UrlFetchApp.fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
    method: 'post',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'OpenAI-Beta': 'assistants=v2',
      'Content-Type': 'application/json',
      'OpenAI-Project': projectId
    },
    payload: JSON.stringify({ assistant_id: assistantId })
  });
  const runId = JSON.parse(runResp.getContentText()).id;

  // 4. Wait for completion
  let status = '', attempts = 0, maxAttempts = 30;
  let statusObj = null;
  const delay = 2000;
  while (attempts < maxAttempts) {
    Utilities.sleep(delay);
    const statusResp = UrlFetchApp.fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'OpenAI-Beta': 'assistants=v2',
        'OpenAI-Project': projectId
      }
    });
    statusObj = JSON.parse(statusResp.getContentText());
    status = statusObj.status;
    if (status === 'completed') break;
    if (status === 'failed') throw new Error('Run failed');
    attempts++;
  }
  if (status !== 'completed') {
    throw new Error('Assistant is busy. Last status: ' + JSON.stringify(statusObj));
  }
  // 5. Get the assistant's reply
  const msgsResp = UrlFetchApp.fetch(`https://api.openai.com/v1/threads/${threadId}/messages?order=asc`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'OpenAI-Beta': 'assistants=v2',
      'OpenAI-Project': projectId
    }
  });
  const assistantMsgs = JSON.parse(msgsResp.getContentText()).data.filter(m => m.role === 'assistant');
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

// ===== Process Chat Message =====
function processChatMessage(email, studentId, assignment, message, assistantId, projectId) {
  try {
    // Get the assistant configuration
    const assistant = getAssistantConfig(assistantId);
    if (!assistant) {
      throw new Error('Assistant configuration not found');
    }

    // Get the project configuration
    const project = getProjectConfig(projectId);
    if (!project) {
      throw new Error('Project configuration not found');
    }

    // Get student name
    const studentName = getStudentName(studentId);

    // Construct the prompt with context
    const prompt = constructChatPrompt(assignment, studentName, message, project);

    // Get response from AI
    const response = getAIResponse(prompt, assistant);

    // Store the interaction
    storeChatInteraction(email, studentId, assignment, message, response, assistantId, projectId);

    return response;
  } catch (error) {
    Logger.log('Error in processChatMessage: ' + error.toString());
    throw error;
  }
}

// ===== Construct Chat Prompt =====
function constructChatPrompt(assignment, studentName, message, project) {
  let prompt = `You are an AI teaching assistant helping a student named ${studentName} with their assignment: ${assignment}\n\n`;
  
  // Add project-specific context
  if (project.context) {
    prompt += `Context for this assignment:\n${project.context}\n\n`;
  }

  // Add any specific instructions
  if (project.instructions) {
    prompt += `Instructions:\n${project.instructions}\n\n`;
  }

  // Add the student's message
  prompt += `Student's message: ${message}\n\n`;
  prompt += `Please provide a helpful and encouraging response that guides the student while maintaining a supportive tone.`;

  return prompt;
}

// ===== Store Chat Interaction =====
function storeChatInteraction(email, studentId, assignment, message, response, assistantId, projectId) {
  const sheetId = PropertiesService.getScriptProperties().getProperty('FEEDBACK_SHEET_ID');
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName('ChatInteractions');
  
  if (!sheet) {
    // Create the sheet if it doesn't exist
    sheet = ss.insertSheet('ChatInteractions');
    sheet.appendRow(['Timestamp', 'Email', 'Student ID', 'Assignment', 'Message', 'Response', 'Assistant ID', 'Project ID']);
  }

  const timestamp = new Date();
  sheet.appendRow([timestamp, email, studentId, assignment, message, response, assistantId, projectId]);
}

// ===== Get Assistant Configuration =====
function getAssistantConfig(assistantId) {
  const sheetId = PropertiesService.getScriptProperties().getProperty('FEEDBACK_SHEET_ID');
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName('AssistantConfig');
  
  if (!sheet) return null;

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const assistantIndex = headers.indexOf('Assistant ID');
  const configIndex = headers.indexOf('Configuration');

  for (let i = 1; i < data.length; i++) {
    if (data[i][assistantIndex] === assistantId) {
      return JSON.parse(data[i][configIndex]);
    }
  }

  return null;
}

// ===== Get Project Configuration =====
function getProjectConfig(projectId) {
  const sheetId = PropertiesService.getScriptProperties().getProperty('FEEDBACK_SHEET_ID');
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName('ProjectConfig');
  
  if (!sheet) return null;

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const projectIndex = headers.indexOf('Project ID');
  const configIndex = headers.indexOf('Configuration');

  for (let i = 1; i < data.length; i++) {
    if (data[i][projectIndex] === projectId) {
      return JSON.parse(data[i][configIndex]);
    }
  }

  return null;
}

// ===== Get AI Response =====
function getAIResponse(prompt, assistant) {
  // This is a placeholder - implement your actual AI integration here
  // You might want to use OpenAI's API or another AI service
  return "I understand your question. Let me help you with that...";
}

// === Utility: Ensure Tab Exists ===
function ensureSheetTab(ss, tabName, headers) {
  let sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.appendRow(headers);
  }
  return sheet;
}

// === Utility: Log Error ===
function logErrorToSheet(error, context) {
  const sheetId = PropertiesService.getScriptProperties().getProperty('FEEDBACK_SHEET_ID');
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ensureSheetTab(ss, 'ErrorLog', ['Timestamp', 'Context', 'Error']);
  sheet.appendRow([new Date(), JSON.stringify(context), error && error.stack ? error.stack : String(error)]);
}

// === Utility: Send Email ===
function sendFeedbackEmail(recipient, subject, body, metadata) {
  try {
    const metaBlock = Object.entries(metadata).map(([k, v]) => `<b>${k}:</b> ${v}`).join('<br>');
    MailApp.sendEmail({
      to: recipient,
      subject: subject,
      htmlBody: metaBlock + '<hr>' + body
    });
  } catch (e) {
    logErrorToSheet(e, { recipient, subject, metadata });
  }
}

// === Utility: Log to Grade Tab ===
function logToGradeTab(grade, headers, row) {
  const sheetId = PropertiesService.getScriptProperties().getProperty('FEEDBACK_SHEET_ID');
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ensureSheetTab(ss, grade, headers);
  sheet.appendRow(row);
}

// === Parse Feedback HTML to JSON ===
function parseFeedbackHtmlToJson(feedbackHtml) {
  const sections = {};
  const regex = /<h2>(.*?)<\/h2>([\s\S]*?)(?=<h2>|$)/gi;
  let match;
  while ((match = regex.exec(feedbackHtml))) {
    const key = match[1].trim();
    const value = match[2].replace(/<[^>]+>/g, '').replace(/[*_`]/g, '').trim();
    sections[key] = value;
  }
  return sections;
}

// === Log and Email Paragraph Feedback ===
function handleParagraphFeedback({
  assistantName, email, studentId, grade, subject, lessonUnit, section, topic,
  studentParagraph, feedbackHtml
}) {
  try {
    const timestamp = new Date();
    const feedbackJson = parseFeedbackHtmlToJson(feedbackHtml);
    const headers = [
      'Timestamp', 'API Assistant Name', 'Email Address', 'Student ID', 'Grade', 'Subject', 'Lesson/Unit', 'Section', 'Topic',
      'Student Paragraph', 'Feedback Structure and Logic', 'Feedback Spelling', 'Feedback Grammar Vocabulary Expression',
      'Feedback Compound Sentences', 'Feedback Transitions', 'Feedback Final'
    ];
    const row = [
      timestamp, assistantName, email, studentId, grade, subject, lessonUnit, section, topic,
      studentParagraph,
      feedbackJson['Structure & Logic'] || '',
      feedbackJson['Spelling'] || '',
      feedbackJson['Grammar, Vocabulary, & Expression'] || '',
      feedbackJson['Compound Sentences'] || '',
      feedbackJson['Transitions'] || '',
      feedbackJson['Feedback'] || ''
    ];
    logToGradeTab(grade, headers, row);
    const metadata = {
      Date: timestamp,
      'Email Address': email,
      'Student ID': studentId,
      Grade: grade,
      Subject: subject,
      'Lesson/Unit': lessonUnit,
      Section: section,
      Topic: topic
    };
    sendFeedbackEmail(email, 'Your Paragraph Feedback', feedbackHtml, metadata);
    sendFeedbackEmail('douglasemmett+2526@edu-g.gsn.ed.jp', 'Student Paragraph Feedback', feedbackHtml, metadata);
  } catch (e) {
    logErrorToSheet(e, { type: 'ParagraphFeedback', email, studentId, grade, subject, lessonUnit, section });
    sendFeedbackEmail('douglasemmett+2526@edu-g.gsn.ed.jp', 'Error in Paragraph Feedback', String(e), { email, studentId, grade });
  }
}

// === Log and Email Chat Feedback ===
function handleChatFeedback({
  assistantName, email, studentId, grade, subject, lessonUnit, section, chatLogJson
}) {
  try {
    const timestamp = new Date();
    const headers = [
      'Timestamp', 'API Assistant Name', 'Email Address', 'Student ID', 'Grade', 'Subject', 'Lesson/Unit', 'Section', 'Chat Conversation'
    ];
    const row = [
      timestamp, assistantName, email, studentId, grade, subject, lessonUnit, section, JSON.stringify(chatLogJson)
    ];
    logToGradeTab(grade, headers, row);
    const metadata = {
      Date: timestamp,
      'Email Address': email,
      'Student ID': studentId,
      Grade: grade,
      Subject: subject,
      'Lesson/Unit': lessonUnit,
      Section: section
    };
    const chatBody = '<pre>' + JSON.stringify(chatLogJson, null, 2) + '</pre>';
    sendFeedbackEmail(email, 'Your Chat Session', chatBody, metadata);
    sendFeedbackEmail('douglasemmett+2526@edu-g.gsn.ed.jp', 'Student Chat Session', chatBody, metadata);
  } catch (e) {
    logErrorToSheet(e, { type: 'ChatFeedback', email, studentId, grade, subject, lessonUnit, section });
    sendFeedbackEmail('douglasemmett+2526@edu-g.gsn.ed.jp', 'Error in Chat Feedback', String(e), { email, studentId, grade });
  }
}
