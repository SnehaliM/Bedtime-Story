// Bedtime Story Generator - front end
// Replace with your API Gateway invoke URL + route, e.g.
// https://abc123.execute-api.us-east-1.amazonaws.com/story
const API_URL = "https://<id>.execute-api.us-east-1.amazonaws.com/bedtime-story";

// API Gateway HTTP APIs time out at 30s, so stop waiting slightly after that
const REQUEST_TIMEOUT_MS = 32000;

const button = document.getElementById("story-btn");
const statusEl = document.getElementById("status");
const card = document.getElementById("story-card");
const titleEl = document.getElementById("story-title");
const textEl = document.getElementById("story-text");
const moralEl = document.getElementById("story-moral");

/**
 * Split the model output into title, body paragraphs, and moral line.
 * Expected shape (from the Lambda prompt):
 *   Title line
 *   ...story paragraphs...
 *   Moral: ...
 */
function parseStory(raw) {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // Strip markdown the model sometimes adds, e.g. "# Title" or "**Title**"
  const clean = (s) => s.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim();

  let title = lines.length > 0 ? clean(lines.shift()) : "A Bedtime Story";
  title = title.replace(/^title:\s*/i, "");

  let moral = "";
  const moralIndex = lines.findIndex((l) => /^\**\s*moral:/i.test(l));
  if (moralIndex !== -1) {
    moral = clean(lines.splice(moralIndex, 1)[0]);
  }

  return { title, paragraphs: lines.map(clean), moral };
}

/**
 * Render using textContent only - model output is treated as plain text,
 * so any HTML/script in the response is displayed, never executed.
 */
function renderStory({ title, paragraphs, moral }) {
  titleEl.textContent = title;

  textEl.replaceChildren();
  for (const para of paragraphs) {
    const p = document.createElement("p");
    p.textContent = para;
    textEl.appendChild(p);
  }

  moralEl.textContent = moral;
  moralEl.hidden = moral.length === 0;

  card.hidden = false;
  // Move focus to the new story so keyboard and screen reader users land on it
  titleEl.focus();
}

function setLoading(isLoading) {
  button.disabled = isLoading;
  button.setAttribute("aria-busy", String(isLoading));
  button.textContent = isLoading ? "Writing your story…" : "Tell me another story";
}

async function fetchStory() {
  setLoading(true);
  statusEl.textContent = "Dreaming up a story…";
  statusEl.classList.remove("error");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(API_URL, {
      method: "GET",
      signal: controller.signal,
    });

    if (response.status === 429) {
      throw new Error("Lots of stories being told right now. Please try again in a moment.");
    }
    if (!response.ok) {
      throw new Error(`The storyteller is resting (HTTP ${response.status}). Please try again.`);
    }

    const data = await response.json();
    if (!data || typeof data.story !== "string" || data.story.trim() === "") {
      throw new Error("The story came back empty. Please try again.");
    }

    renderStory(parseStory(data.story));
    statusEl.textContent = "Here's your story. Sweet dreams.";
  } catch (err) {
    const message =
      err.name === "AbortError"
        ? "The story took too long to arrive. Please try again."
        : err instanceof TypeError
          ? "Couldn't reach the storyteller. Check the API URL and CORS settings."
          : err.message;
    statusEl.textContent = message;
    statusEl.classList.add("error");
    console.error("Story request failed:", err);
  } finally {
    clearTimeout(timer);
    setLoading(false);
  }
}

button.addEventListener("click", fetchStory);
