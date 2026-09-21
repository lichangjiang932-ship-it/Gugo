/**
 * Labels for the ReAct completion report and its folded trajectory.
 *
 * Kept in its own domain so it stays a cohesive unit: these label what the
 * *agent* produced (Thought / Action / Observation) rather than chat chrome.
 */
const translations = {
  "zh": {
    "thought": "思考",
    "action": "行动",
    "observation": "观察"
  },
  "en": {
    "thought": "Thought",
    "action": "Action",
    "observation": "Observation"
  }
}

export default translations
