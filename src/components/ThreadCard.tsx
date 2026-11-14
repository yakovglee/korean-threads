import { avatarIndex, initials, keepSuffix, type Post, type ThreadItem } from "@/lib/demo-data";
import { KoText, type WordTap } from "./KoText";

type CommonProps = {
  activeKey: string | null;
  onWord: (tap: WordTap, el: HTMLButtonElement) => void;
};

function Avatar({ author, nick }: { author: string; nick: string }) {
  return (
    <div className={`avatar av-${avatarIndex(nick)}`} aria-hidden="true">
      {initials(author)}
    </div>
  );
}

function Head({ post }: { post: Post }) {
  return (
    <div className="post__head">
      <span className="post__name" lang="ko">
        {post.author}
      </span>
      <span className="post__meta">@{post.nick}</span>
      <span className="post__time">
        <span className="post__dot" aria-hidden="true">
          ·
        </span>
        {post.when}
      </span>
    </div>
  );
}

function Body({ post, activeKey, onWord }: CommonProps & { post: Post }) {
  return (
    <div className="post__body">
      {post.paragraphs.map((p, i) =>
        p.kind === "ko" ? (
          <KoText key={i} text={p.text} scope={`${post.id}:${i}`} activeKey={activeKey} onWord={onWord} />
        ) : (
          <p key={i} className="note" lang="ru">
            {keepSuffix(p.text)}
          </p>
        ),
      )}
      {post.source ? <p className="source">источник: {post.source}</p> : null}
    </div>
  );
}

function ShortPost({ post, linked, ...rest }: CommonProps & { post: Post; linked: boolean }) {
  return (
    <div className={`post${linked ? " post--linked" : ""}`}>
      <div className="post__rail">
        <Avatar author={post.author} nick={post.nick} />
      </div>
      <div className="post__main">
        <Head post={post} />
        <Body post={post} {...rest} />
      </div>
    </div>
  );
}

function ArticlePost({ post, activeKey, onWord }: CommonProps & { post: Post }) {
  return (
    <div className="post post--article">
      <div className="post__who">
        <Avatar author={post.author} nick={post.nick} />
        <Head post={post} />
      </div>
      {post.title ? (
        <KoText
          as="h3"
          className="post__title"
          text={post.title}
          scope={`${post.id}:title`}
          activeKey={activeKey}
          onWord={onWord}
        />
      ) : null}
      <Body post={post} activeKey={activeKey} onWord={onWord} />
    </div>
  );
}

/** Карточка-ветка: короткие посты в духе Threads или длинный разбор в духе Substack (П-6) */
export function ThreadCard({ item, ...rest }: CommonProps & { item: ThreadItem }) {
  return (
    <article className="card">
      {item.posts.map((post, i) =>
        post.variant === "article" ? (
          <ArticlePost key={post.id} post={post} {...rest} />
        ) : (
          <ShortPost key={post.id} post={post} linked={i < item.posts.length - 1} {...rest} />
        ),
      )}
    </article>
  );
}
