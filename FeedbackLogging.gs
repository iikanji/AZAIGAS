// FeedbackLogging.gs
// Utility functions for logging, emailing, and error handling for feedback and chat in Arizona AI

/**
 * Ensure a sheet tab exists, create with headers if missing.
 */
function ensureSheetTab(ss, tabName, headers) {
  let sheet = ss.getSheetByName(tabName);
  if (!sheet) {
    sheet = ss.insertSheet(tabName);
    sheet.appendRow(headers);
  }
  return sheet;
}

/**
 * Log an error to the ErrorLog tab.
 */
function logErrorToSheet(error, context) {
  const sheetId = PropertiesService.getScriptProperties().getProperty('FEEDBACK_SHEET_ID');
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ensureSheetTab(ss, 'ErrorLog', ['Timestamp', 'Context', 'Error']);
  sheet.appendRow([new Date(), JSON.stringify(context), error && error.stack ? error.stack : String(error)]);
}

/**
 * Send feedback or chat log email to a recipient.
 */
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

/**
 * Log feedback or chat to the correct grade tab, create tab if missing.
 */
function logToGradeTab(grade, headers, row) {
  const sheetId = PropertiesService.getScriptProperties().getProperty('FEEDBACK_SHEET_ID');
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ensureSheetTab(ss, grade, headers);
  sheet.appendRow(row);
}

/**
 * Parse feedback HTML into a JSON object with category keys and plain text values.
 */
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

/**
 * Look up student name by studentId from the NameList tab in FEEDBACK_SHEET_ID.
 * Assumes 現在の連番 is the Student ID and 氏名 is the name.
 */
function getStudentNameFromSheet(studentId) {
  Logger.log('getStudentNameFromSheet called with studentId: ' + studentId);
  const sheetId = PropertiesService.getScriptProperties().getProperty('FEEDBACK_SHEET_ID');
  Logger.log('Using FEEDBACK_SHEET_ID: ' + sheetId);
  const ss = SpreadsheetApp.openById(sheetId);
  const sheet = ss.getSheetByName('NameList');
  if (!sheet) {
    Logger.log('NameList sheet not found');
    return studentId; // fallback
  }
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('現在の連番');
  const nameCol = headers.indexOf('氏名');
  Logger.log('Headers: ' + headers.join(','));
  Logger.log('idCol: ' + idCol + ', nameCol: ' + nameCol);
  if (idCol === -1 || nameCol === -1) {
    Logger.log('ID or Name column not found');
    return studentId;
  }
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]).trim() === String(studentId).trim()) {
      Logger.log('Student name found: ' + data[i][nameCol]);
      return data[i][nameCol] || studentId;
    }
  }
  Logger.log('Student ID not found in NameList');
  return studentId; // fallback if not found
}

/**
 * Log and email paragraph feedback, and handle errors.
 */
function handleParagraphFeedback({
  assistantName, email, studentId, grade, subject, lessonUnit, section, topic,
  studentParagraph, feedbackHtml
}) {
  try {
    Logger.log('handleParagraphFeedback called with: ' + JSON.stringify({assistantName, email, studentId, grade, subject, lessonUnit, section, topic, studentParagraph, feedbackHtml}));
    const timestamp = new Date();
    const feedbackJson = parseFeedbackHtmlToJson(feedbackHtml);
    Logger.log('Parsed feedbackJson: ' + JSON.stringify(feedbackJson));
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
    Logger.log('Row to log: ' + JSON.stringify(row));
    logToGradeTab(grade, headers, row);
    const studentName = getStudentNameFromSheet(studentId);
    Logger.log('Student name for email: ' + studentName);
    const subjectLine = `[${studentName}]! Your feedback is ready!`;
    const body = `Dear ${studentName},<br><br>Your most recent assignment has been checked. A copy has been forwarded to you for your convenience and personal edification.<br><br>Sincerely,<br>Arizona AI<hr>${feedbackHtml}`;
    Logger.log('Email subject: ' + subjectLine);
    Logger.log('Email body: ' + body);
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
    Logger.log('Email metadata: ' + JSON.stringify(metadata));
    sendFeedbackEmail(email, subjectLine, body, metadata);
    sendFeedbackEmail('douglasemmett+2526@edu-g.gsn.ed.jp', subjectLine, body, metadata);
  } catch (e) {
    Logger.log('Error in handleParagraphFeedback: ' + (e && e.stack ? e.stack : e));
    logErrorToSheet(e, { type: 'ParagraphFeedback', email, studentId, grade, subject, lessonUnit, section });
    sendFeedbackEmail('douglasemmett+2526@edu-g.gsn.ed.jp', 'Error in Paragraph Feedback', String(e), { email, studentId, grade });
  }
}

/**
 * Log and email chat feedback, and handle errors.
 */
function handleChatFeedback({
  assistantName, email, studentId, grade, subject, lessonUnit, section, chatLogJson
}) {
  try {
    Logger.log('handleChatFeedback called with: ' + JSON.stringify({assistantName, email, studentId, grade, subject, lessonUnit, section, chatLogJson}));
    const timestamp = new Date();
    const headers = [
      'Timestamp', 'API Assistant Name', 'Email Address', 'Student ID', 'Grade', 'Subject', 'Lesson/Unit', 'Section', 'Chat Conversation'
    ];
    const row = [
      timestamp, assistantName, email, studentId, grade, subject, lessonUnit, section, JSON.stringify(chatLogJson)
    ];
    Logger.log('Row to log: ' + JSON.stringify(row));
    logToGradeTab(grade, headers, row);
    const studentName = getStudentNameFromSheet(studentId);
    Logger.log('Student name for email: ' + studentName);
    const subjectLine = `[${studentName}]! Your feedback is ready!`;
    const chatBody = `Dear ${studentName},<br><br>Your most recent assignment has been checked. A copy has been forwarded to you for your convenience and personal edification.<br><br>Sincerely,<br>Arizona AI<hr><pre>${JSON.stringify(chatLogJson, null, 2)}</pre>`;
    Logger.log('Email subject: ' + subjectLine);
    Logger.log('Email body: ' + chatBody);
    const metadata = {
      Date: timestamp,
      'Email Address': email,
      'Student ID': studentId,
      Grade: grade,
      Subject: subject,
      'Lesson/Unit': lessonUnit,
      Section: section
    };
    Logger.log('Email metadata: ' + JSON.stringify(metadata));
    sendFeedbackEmail(email, subjectLine, chatBody, metadata);
    sendFeedbackEmail('douglasemmett+2526@edu-g.gsn.ed.jp', subjectLine, chatBody, metadata);
  } catch (e) {
    Logger.log('Error in handleChatFeedback: ' + (e && e.stack ? e.stack : e));
    logErrorToSheet(e, { type: 'ChatFeedback', email, studentId, grade, subject, lessonUnit, section });
    sendFeedbackEmail('douglasemmett+2526@edu-g.gsn.ed.jp', 'Error in Chat Feedback', String(e), { email, studentId, grade });
  }
}

function testParagraphFeedback() {
  handleParagraphFeedback({
    assistantName: 'TestAssistant',
    email: 'your@email.com',
    studentId: '12345',
    grade: '1',
    subject: 'Math',
    lessonUnit: 'Unit 1',
    section: 'Section A',
    topic: 'Algebra',
    studentParagraph: 'This is a test paragraph.',
    feedbackHtml: '<h2>Structure & Logic</h2>Good.<h2>Spelling</h2>None.'
  });
} 