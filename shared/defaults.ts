import type { Mode, Scorecard, Settings } from './types';
export const DEFAULT_EMAIL_TEMPLATE = 'Subject line\nShort thank-you\nKey decisions\nNext steps and explicitly stated owners\nOpen questions\nProfessional closing';
export const DEFAULT_SETTINGS: Settings = {
  theme: 'light', opacity: 0.97, contentProtection: true, clickthrough: false,
  captureSystem: true, captureMicrophone: true, captureScreen: true, displayId: '',
  language: 'en', outputLanguage: 'English', model: 'gpt-4.1-mini', transcriptionModel: 'nova-3', instructions: '',
  smartMode: false, autoAssist: false, launchAtLogin: false, activeModeId: 'general',
  smartModel: 'gpt-5.4-mini', smartReasoningEffort: 'medium', smartWebSearch: true, smartMaxOutputTokens: 25000,
  meetingDetectionEnabled: false, meetingStartAction: 'alert', meetingEndAction: 'alert', meetingStartDelaySeconds: 3, meetingEndDelaySeconds: 20,
  meetingAppBundleIds: ['us.zoom.xos', 'com.microsoft.teams', 'com.microsoft.teams2', 'com.cisco.webexmeetingsapp', 'com.webex.meetingmanager', 'com.apple.FaceTime', 'com.tinyspeck.slackmacgap', 'exe:zoom.exe', 'exe:ms-teams.exe', 'exe:teams.exe', 'exe:webex.exe', 'exe:ciscowebexstart.exe', 'exe:discord.exe', 'exe:slack.exe', 'exe:skype.exe'], meetingBrowserAlerts: true, meetingBrowserAutoStart: false,
  onboardingCompleted: false,
  automaticPreparation: false, preparationLeadMinutes: 15, preparationRefreshMinutes: 60,
  shortcuts: { toggleOverlay: 'CommandOrControl+B', assist: 'CommandOrControl+Enter', toggleClickthrough: 'CommandOrControl+Shift+I', moveLeft: 'CommandOrControl+Shift+Left', moveRight: 'CommandOrControl+Shift+Right', moveUp: 'CommandOrControl+Shift+Up', moveDown: 'CommandOrControl+Shift+Down', scrollUp: 'CommandOrControl+Up', scrollDown: 'CommandOrControl+Down', clearChat: 'CommandOrControl+K', startStopSession: 'CommandOrControl+Shift+Space' },
};
export const BUILTIN_MODES: Mode[] = [
  { id: 'general', name: 'General', instructions: 'Give concise, useful assistance grounded in the conversation and visible screen.', noteTemplate: 'Summary\nKey points\nDecisions\nAction items\nOpen questions', documentIds: [], builtIn: true },
  { id: 'meeting', name: 'Meeting', instructions: 'Help prepare useful contributions, clarify decisions, and track owners and next steps.', noteTemplate: 'Purpose\nDiscussion\nDecisions\nActions and owners\nNext meeting', documentIds: [], builtIn: true },
  { id: 'sales', name: 'Sales', instructions: 'Help understand buyer needs, ask discovery questions, respond truthfully to objections, and agree on next steps. Never invent product claims.', noteTemplate: 'Customer needs\nObjections\nRequirements\nNext steps and owners', documentIds: [], builtIn: true },
  { id: 'interview', name: 'Interview', instructions: 'Help articulate authentic experience and reason clearly through the questions. Use only provided facts about the user.', noteTemplate: 'Questions\nRelevant experience\nFeedback\nFollow-up', documentIds: [], builtIn: true },
];
export const BUILTIN_SCORECARDS: Scorecard[] = [{ id: 'conversation', name: 'Conversation quality', instructions: 'Assess only what the transcript supports. Give practical ways to improve the next conversation.', criteria: [
  { id: 'purpose', name: 'Clear purpose', description: 'The discussion identifies the problem, goal, or decision to be made.', maxScore: 5, weight: 1 },
  { id: 'questions', name: 'Useful questions', description: 'Participants ask specific questions that clarify needs and constraints.', maxScore: 5, weight: 1 },
  { id: 'grounding', name: 'Grounded contributions', description: 'Contributions reference concrete facts or relevant experience without unsupported claims.', maxScore: 5, weight: 1 },
  { id: 'next-steps', name: 'Clear next steps', description: 'The conversation agrees on concrete next steps and explicit owners when needed.', maxScore: 5, weight: 1 },
] }];
export const PROTECTION_WARNING = 'Content protection requests exclusion from supported capture tools. macOS ScreenCaptureKit can capture protected Electron windows; verify your exact sharing app before relying on it.';
