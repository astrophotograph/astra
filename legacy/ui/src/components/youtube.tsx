export const YouTube = ({ title, id }: { title: string; id: string }) => {
  return (
    <div
      className={
        "overflow-hidden rounded-lg border border-teal-300 bg-white shadow-lg"
      }
    >
      <iframe
        src={`https://www.youtube.com/embed/${id}`}
        className={"aspect-video h-full w-full"}
        title={title}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
      />
    </div>
  );
};
