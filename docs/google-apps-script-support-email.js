/**
 * Google Apps Script — Stage 1 of the Automated Support Pipeline
 *
 * Watches starred emails sent to support@drafto.eu, creates GitHub issues
 * with the `support` label, and uploads any email attachments as images
 * embedded in the issue body.
 *
 * Setup:
 *   1. Open https://script.google.com and create a new project
 *   2. Paste this script
 *   3. Add script property: GITHUB_TOKEN (Settings → Script Properties)
 *   4. Add a time-driven trigger for processStarredSupportEmails (daily at 23:00)
 *
 * How attachments work:
 *   - Email attachments are uploaded to the GitHub repo via the Contents API
 *     (base64-encoded, stored in `support-attachments/` directory)
 *   - Uses includeInlineImages: true because Gmail classifies MIME parts
 *     with Content-ID headers as inline images, even when Content-Disposition
 *     is "attachment" — without this flag, such attachments are silently excluded
 *   - Each file is named with the issue timestamp + original filename to avoid collisions
 *   - Image attachments are embedded as ![img](...) in the issue body
 *   - Non-image attachments are linked as regular markdown links
 *
 * See also: docs/adr/0013-automated-support-pipeline.md
 */

function fetchWithRetry(url, options, maxRetries) {
  var response;
  for (var attempt = 1; attempt <= maxRetries; attempt++) {
    response = UrlFetchApp.fetch(url, options);
    var code = response.getResponseCode();
    if (code < 500 || attempt === maxRetries) return response;
    console.warn("Retrying (attempt " + attempt + "/" + maxRetries + ") after HTTP " + code);
    Utilities.sleep(attempt * 1000);
  }
  return response;
}

function processStarredSupportEmails() {
  var GITHUB_TOKEN = PropertiesService.getScriptProperties().getProperty("GITHUB_TOKEN");
  if (!GITHUB_TOKEN) {
    throw new Error("GITHUB_TOKEN script property is not set");
  }
  var REPO = "JakubAnderwald/drafto";
  var SUPPORT_ADDRESS = "support@drafto.eu";
  var ATTACHMENT_PATH = "support-attachments";

  var threads = GmailApp.search("is:starred to:" + SUPPORT_ADDRESS);
  if (threads.length === 0) return;

  for (var t = 0; t < threads.length; t++) {
    var thread = threads[t];
    var msg = thread.getMessages()[0];
    var subject = msg.getSubject() || "(No subject)";
    var sender = msg.getFrom();
    var date = msg.getDate().toISOString();
    var body = msg.getPlainBody();
    var attachments = msg.getAttachments({
      includeInlineImages: true,
      includeAttachments: true,
    });

    // Upload attachments and collect markdown references
    var attachmentMarkdown = "";
    if (attachments.length > 0) {
      var timestamp = date.replace(/[^0-9]/g, "").slice(0, 14);
      attachmentMarkdown = "\n\n---\n\n**Attachments:**\n\n";

      for (var i = 0; i < attachments.length; i++) {
        try {
          var attachment = attachments[i];
          var originalName = attachment.getName() || "attachment-" + (i + 1);
          var safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
          var filePath = ATTACHMENT_PATH + "/" + timestamp + "-" + safeName;
          var contentType = attachment.getContentType();
          var bytes = attachment.getBytes();

          if (!bytes || bytes.length === 0) {
            console.warn("Skipping empty attachment: " + originalName);
            attachmentMarkdown += "Skipped (empty): " + originalName + "\n\n";
            continue;
          }

          var base64Content = Utilities.base64Encode(bytes);

          var apiHeaders = {
            Authorization: "Bearer " + GITHUB_TOKEN,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          };
          var apiUrl = "https://api.github.com/repos/" + REPO + "/contents/" + filePath;
          var uploadPayload = {
            message: "chore: upload support attachment " + originalName,
            content: base64Content,
          };

          var uploadResponse = fetchWithRetry(
            apiUrl,
            {
              method: "put",
              contentType: "application/json",
              headers: apiHeaders,
              payload: JSON.stringify(uploadPayload),
              muteHttpExceptions: true,
            },
            3,
          );

          // Handle 409 Conflict (file already exists from a previous partial run)
          if (uploadResponse.getResponseCode() === 409) {
            var existingFile = fetchWithRetry(
              apiUrl,
              {
                method: "get",
                headers: apiHeaders,
                muteHttpExceptions: true,
              },
              3,
            );
            if (existingFile.getResponseCode() === 200) {
              var sha = JSON.parse(existingFile.getContentText()).sha;
              uploadPayload.sha = sha;
              uploadResponse = fetchWithRetry(
                apiUrl,
                {
                  method: "put",
                  contentType: "application/json",
                  headers: apiHeaders,
                  payload: JSON.stringify(uploadPayload),
                  muteHttpExceptions: true,
                },
                3,
              );
            }
          }

          var uploadCode = uploadResponse.getResponseCode();
          if (uploadCode === 201 || uploadCode === 200) {
            var uploadData = JSON.parse(uploadResponse.getContentText());
            var downloadUrl = uploadData.content.download_url;

            if (contentType && contentType.indexOf("image/") === 0) {
              attachmentMarkdown += "![" + originalName + "](" + downloadUrl + ")\n\n";
            } else {
              attachmentMarkdown += "[" + originalName + "](" + downloadUrl + ")\n\n";
            }
          } else {
            console.error(
              "Failed to upload attachment: " + originalName + " (HTTP " + uploadCode + ")",
            );
            attachmentMarkdown +=
              "Failed to upload: " + originalName + " (HTTP " + uploadCode + ")\n\n";
          }
        } catch (e) {
          var failedName = (attachments[i] && attachments[i].getName()) || "attachment-" + (i + 1);
          console.error("Error processing attachment " + failedName + ": " + e.message);
          attachmentMarkdown += "Failed to process: " + failedName + "\n\n";
        }
      }
    }

    var issueBody =
      "**From:** " + sender + "\n**Date:** " + date + "\n\n---\n\n" + body + attachmentMarkdown;

    var response = UrlFetchApp.fetch("https://api.github.com/repos/" + REPO + "/issues", {
      method: "post",
      contentType: "application/json",
      headers: {
        Authorization: "Bearer " + GITHUB_TOKEN,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      payload: JSON.stringify({ title: subject, body: issueBody, labels: ["support"] }),
      muteHttpExceptions: true,
    });

    if (response.getResponseCode() === 201) {
      thread.getMessages().forEach(function (m) {
        m.unstar();
      });
    } else {
      console.error(
        "Failed to create issue for: " + subject + " (HTTP " + response.getResponseCode() + ")",
      );
    }
  }
}
