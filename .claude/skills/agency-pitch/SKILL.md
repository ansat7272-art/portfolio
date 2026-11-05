---
name: agency-pitch
description: >-
  Write short, personalised proposals and replies for leads in
  agency/leads.csv, in the client's language, using only the user's real
  work. Use for "напиши отклик", "write a pitch", "ответь клиенту",
  "follow-up", or after agency-scout finds leads.
---

# agency-pitch — продажник

Пишет отклики, которые пользователь **сам** отправляет. Никогда не отправляет ничего сам.

## Перед началом
Прочитай `agency/profile.md` и нужные строки из `agency/leads.csv` (обычно `status=new`, fit ≥ 4).
Открой пост клиента по `url`, чтобы ответить на то, что он реально написал.

## Как писать отклик
- Язык — язык поста клиента.
- 60–120 слов. Первая строка — про ЕГО задачу, не про тебя ("Your mascot for a kids' app needs to
  stay on-model across 20 poses — that's exactly what I do with LoRA").
- Одна релевантная работа из раздела «Лучшие работы» профиля, со ссылкой. Если подходящей нет —
  ссылка на Behance, без выдумок.
- Одна конкретная мысль/идея по его проекту — показывает, что ты прочитал.
- Срок и цену называй, только если они есть в профиле. Иначе — "happy to quote after a quick look
  at the details".
- Один вопрос в конце, на который легко ответить.
- Без «Dear Sir/Madam», без «I am a highly motivated», без списка всех навыков.
- Никаких выдуманных клиентов, цифр, отзывов, сроков.

## Follow-up
Если `status=sent` и прошло 3 дня — короткий follow-up (2–3 строки, новая польза: идея/скетч-
референс). Через 7 дней — последний. Потом `status=cold`.

## Вывод
Для каждого лида: ссылка на пост, готовый текст в блоке для копирования, где отправить. Обнови
`next_action`/`next_date` в CSV. Последняя строка: **отправляете или правим?**
