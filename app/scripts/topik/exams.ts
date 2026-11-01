// Манифест официальных экзаменов в books/TOPIK (ADR 0004, 0005). Пути — относительно books/TOPIK.
// Чтение берётся из всех экзаменов, аудирование — только из 83, 91, 96 (TOPIK II) и 102.

export type ExamSource = {
  session: number;
  level: "I" | "II";
  // Буклет с чтением. В TOPIK I чтение и аудирование в одном буклете: чтение — задания 31–70.
  reading: string;
  // Ключи ответов (정답표); у некоторых сессий их два файла.
  keys: string[];
  // Буклет «듣기 통합» (задания со скриптом) и папка с треками по заданиям.
  listening?: {
    script: string;
    audio: string;
    // dash: «1-07.mp3» — номер задания; track: «08 트랙 8.mp3» — трек 1 вступление, задание = трек − 1.
    tracks: "dash" | "track";
  };
};

export const EXAMS: ExamSource[] = [
  { session: 35, level: "I", reading: "35회 TOPIK1(듣기읽기).pdf", keys: ["35회_TOPIK1_읽기(정답표).pdf"] },
  { session: 35, level: "II", reading: "35회 TOPIK 2_2교시(읽기).pdf", keys: ["35회 TOPIK 2_읽기(정답표).pdf"] },
  { session: 36, level: "I", reading: "36회 TOPIK1(듣기읽기)_B형.pdf", keys: ["36회 TOPIK1_B형 정답표.pdf"] },
  { session: 36, level: "II", reading: "36회 TOPIK 2_(듣기쓰기읽기)_B형.pdf", keys: ["36회 토픽2_B형 정답표.pdf"] },
  { session: 37, level: "I", reading: "37회TOPIK1(듣기읽기)_B형.pdf", keys: ["37회 TOPIK1_정답표.pdf"] },
  { session: 37, level: "II", reading: "37회TOPIK2(듣기쓰기읽기)_B형.pdf", keys: ["37회 TOPIK2_정답표.pdf"] },
  // Ключей 41-го в books/TOPIK нет: без ключа экзамен пропускается.
  { session: 41, level: "I", reading: "41회 TOPIK I(듣기, 읽기)_B형.pdf", keys: [] },
  { session: 41, level: "II", reading: "41회 TOPIK II_2교시(읽기)_B형.pdf", keys: [] },
  {
    session: 47,
    level: "I",
    reading: "47회_TOPIK1_기출 및 정답/47회_문제지_TOPIK1_듣기,읽기(B형).pdf",
    keys: ["47회_TOPIK1_기출 및 정답/47회_정답 및 배점표_TOPIK1(B형).pdf"],
  },
  {
    session: 47,
    level: "II",
    reading: "47회_TOPIK2_기출 및 정답/47회_문제지_TOPIK2_2교시_읽기(B형).pdf",
    keys: ["47회_TOPIK2_기출 및 정답/47회_정답 및 배점표_TOPIK2(B형).pdf"],
  },
  {
    session: 52,
    level: "I",
    reading: "52회_TOPIK1_기출 및 정답/52회_문제지_TOPIK1_1듣기읽기(B_홀수형).pdf",
    keys: ["52회_TOPIK1_기출 및 정답/52회_TOPIK1_정답지(B- 홀수형).pdf"],
  },
  {
    session: 52,
    level: "II",
    reading: "52회_TOPIK2_기출 및 정답/52회_TOPIK2_기출 및 정답/52회_문제지_TOPIK2_2읽기(B_홀수형).pdf",
    keys: ["52회_TOPIK2_기출 및 정답/52회_TOPIK2_기출 및 정답/52회_정답지_TOPIK2_듣기읽기쓰기(B-홀수형).pdf"],
  },
  {
    session: 60,
    level: "I",
    reading: "60회_TOPIK1_기출 및 정답/60Čļ_đŪÁĶÁö_TOPIK1_ĩčąâ, ĀÐąâ(B-ČĶžöĮü).pdf",
    keys: ["60회_TOPIK1_기출 및 정답/60회_정답 및 배점표_TOPIK1_읽기(B-홀수형).pdf"],
  },
  {
    session: 60,
    level: "II",
    reading: "60회_TOPIK2_기출 및 정답/60회_문제지_TOPIK2_2교시_읽기(B-홀수형).pdf",
    keys: ["60회_TOPIK2_기출 및 정답/60회_정답 및 채점기준표.pdf"],
  },
  {
    session: 64,
    level: "I",
    reading: "64회_TOPIK1_기출 및 정답/64회_문제지_TOPIK1_듣기_읽기.pdf",
    keys: ["64회_TOPIK1_기출 및 정답/64회_정답 및 배점표_TOPIK1.pdf"],
  },
  {
    session: 64,
    level: "II",
    reading: "64회_TOPIK2_기출 및 정답/64회_문제지 TOPIK2_2교시_읽기.pdf",
    keys: ["64회_TOPIK2_기출 및 정답/64회_정답_TOPIK2.pdf"],
  },
  {
    session: 83,
    level: "I",
    reading: "83회_문제지_TOPIK1_듣기, 읽기.pdf",
    keys: ["83회_정답 및 배점표_TOPIK1.pdf"],
    listening: { script: "83회_문제지_TOPIK1_듣기 통합.pdf", audio: "제83회 토픽1 듣기파일", tracks: "track" },
  },
  {
    session: 83,
    level: "II",
    reading: "83회_문제지 TOPIK2_2교시_읽기.pdf",
    keys: ["83회_정답 및 배점표_TOPIK2.pdf"],
    listening: { script: "83회_문제지_TOPIK2_1교시_듣기 통합.pdf", audio: "제83회 토픽2 듣기파일", tracks: "track" },
  },
  {
    session: 91,
    level: "I",
    reading: "제91회_문제지_TOPIK1_듣기, 읽기_탑재용.pdf",
    keys: ["제91회_정답 및 배점표_TOPIK1_탑재용.pdf"],
    listening: { script: "제91회_문제지_TOPIK1_듣기통합_탑재용.pdf", audio: "ÁĶ91Čļ ÅäĮČ1 ĩčąâÆÄĀÏ", tracks: "track" },
  },
  {
    session: 91,
    level: "II",
    reading: "제91회_문제지 TOPIK2_2교시_읽기_탑재용.pdf",
    keys: ["제91회_정답 및 배점표_TOPIK2_탑재용.pdf"],
    listening: { script: "제91회_문제지_TOPIK2_1교시_듣기 통합_탑재용.pdf", audio: "ÁĶ91Čļ ÅäĮČ2 ĩčąâÆÄĀÏ", tracks: "track" },
  },
  // У 96-го TOPIK I аудиофайлов нет (ADR 0005): только чтение.
  {
    session: 96,
    level: "I",
    reading: "제96회_문제지_TOPIK1_듣기, 읽기_탑재용.pdf",
    keys: ["제96회_정답 및 배점표_TOPIK1_탑재용.pdf"],
  },
  {
    session: 96,
    level: "II",
    reading: "제96회_문제지 TOPIK2_2교시_읽기_탑재용.pdf",
    keys: [], // ключа 96-го TOPIK II в books/TOPIK нет — положите его и впишите сюда
    listening: {
      script: "제96회_문제지_TOPIK2_1교시_듣기 통합_탑재용.pdf",
      audio: "제96회 TOPIK2 듣기파일/제96회 TOPIK2I 듣기파일",
      tracks: "dash",
    },
  },
  {
    session: 102,
    level: "I",
    reading: "제102회_문제지_TOPIK1_듣기, 읽기_탑재용 (1).pdf",
    keys: ["제102회_정답 및 배점표_TOPIK1_탑재용.pdf"],
    listening: { script: "제102회_문제지_TOPIK1_듣기통합_탑재용.pdf", audio: "제102회 TOPIK1 듣기파일", tracks: "dash" },
  },
  {
    session: 102,
    level: "II",
    reading: "제102회_문제지 TOPIK2_2교시_읽기_탑재용.pdf",
    keys: ["제102회_정답 및 배점표_TOPIK2_탑재용.pdf"],
    listening: {
      script: "제102회_문제지_TOPIK2_1교시_듣기 통합_탑재용.pdf",
      audio: "제102회 TOPIK2 듣기파일",
      tracks: "dash",
    },
  },
];

export const examId = (e: { session: number; level: string }) => `${e.session}-${e.level}`;
