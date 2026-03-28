interface Props {
  username: string | null;
}

export function Footer({ username }: Props) {
  return (
    <footer>
      Shared via <a href="https://astra.gallery">Astra</a>
      {username && (
        <>
          <span class="sep">&middot;</span>
          <a href={`/@${username}/`}>@{username}</a>
        </>
      )}
    </footer>
  );
}
