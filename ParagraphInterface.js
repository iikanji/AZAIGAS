// ===== New Process Paragraph Submission (OpenAI Assistant API, minimal) =====
function processParagraphWithAssistant(email, studentId, assignment, paragraph, assistantId, projectId) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  const feedbackSheetId = PropertiesService.getScriptProperties().getProperty('FEEDBACK_SHEET_ID');
  Logger.log('processParagraphWithAssistant called with:');
  Logger.log({ email, studentId, assignment, paragraph, assistantId, projectId });
  if (!apiKey || !feedbackSheetId || !assistantId || !projectId) {
    Logger.log('Missing required script properties:', { apiKey, feedbackSheetId, assistantId, projectId });
    return HtmlService.createHtmlOutput("<p>Error: Required script properties not set.</p>").getContent();
  }
  try {
    // 1. Create a thread
    const threadResp = UrlFetchApp.fetch('https://api.openai.com/v1/threads', {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'OpenAI-Beta': 'assistants=v2',
        'Content-Type': 'application/json',
        'OpenAI-Project': projectId
      }
    });
    Logger.log('Thread response: ' + threadResp.getContentText());
    const threadId = JSON.parse(threadResp.getContentText()).id;
    // 2. Add user message (just the paragraph)
    const userMsgPayload = { role: 'user', content: paragraph };
    Logger.log('User message payload: ' + JSON.stringify(userMsgPayload));
    const userMsgResp = UrlFetchApp.fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'OpenAI-Beta': 'assistants=v2',
        'Content-Type': 'application/json',
        'OpenAI-Project': projectId
      },
      payload: JSON.stringify(userMsgPayload)
    });
    Logger.log('User message response: ' + userMsgResp.getContentText());
    // 3. Run the assistant
    const runPayload = { assistant_id: assistantId };
    Logger.log('Run payload: ' + JSON.stringify(runPayload));
    const runResp = UrlFetchApp.fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
      method: 'post',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'OpenAI-Beta': 'assistants=v2',
        'Content-Type': 'application/json',
        'OpenAI-Project': projectId
      },
      payload: JSON.stringify(runPayload)
    });
    Logger.log('Run response: ' + runResp.getContentText());
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
      Logger.log(`Run status check #${attempts + 1}:`, statusObj);
      if (status === 'completed') break;
      if (status === 'failed') throw new Error('Run failed');
      attempts++;
    }
    if (status !== 'completed') {
      Logger.log('Final assistant status: ' + status);
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
    Logger.log('Messages response:', msgsResp.getContentText());
    const assistantMsgs = JSON.parse(msgsResp.getContentText()).data.filter(m => m.role === 'assistant');
    const last = assistantMsgs.pop();
    Logger.log('Last assistant message:', last);
    const feedbackHtml = last?.content?.[0]?.text?.value || '<p>(Error: No response from assistant)</p>';
    // Optionally store feedback, email, etc. as before
    return HtmlService.createHtmlOutput(feedbackHtml).getContent();
  } catch (err) {
    Logger.log('Exception:', err);
    return HtmlService.createHtmlOutput("<p>Error processing request: " + err + "</p>").getContent();
  }
} 