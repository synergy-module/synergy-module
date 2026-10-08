const MATRIX_CHARACTERS = "01";
const CHARACTER_SIZE = 14;

export function startMatrix(canvas) {
  const windowRef = canvas.ownerDocument?.defaultView ?? window;
  const context = canvas.getContext("2d");
  let animationFrame = null;
  let columns = 1;
  let drops = [0];

  const resize = () => {
    canvas.width = windowRef.innerWidth;
    canvas.height = windowRef.innerHeight;
    columns = Math.max(1, Math.floor(canvas.width / CHARACTER_SIZE));
    drops = new Array(columns).fill(0);
  };

  const draw = () => {
    context.fillStyle = "rgba(8,4,10,0.15)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.font = "14px monospace";
    for (let index = 0; index < columns; index += 1) {
      const character = MATRIX_CHARACTERS[(Math.random() * MATRIX_CHARACTERS.length) | 0];
      context.fillStyle = Math.random() > 0.94 ? "#f7eaeb" : "rgba(255,46,67,0.85)";
      context.fillText(character, index * CHARACTER_SIZE, drops[index] * CHARACTER_SIZE);
      drops[index] = drops[index] * CHARACTER_SIZE > canvas.height && Math.random() > 0.975 ? 0 : drops[index] + 1;
    }
    animationFrame = windowRef.requestAnimationFrame(draw);
  };

  resize();
  windowRef.addEventListener("resize", resize);
  if (context) animationFrame = windowRef.requestAnimationFrame(draw);

  return () => {
    if (animationFrame !== null) windowRef.cancelAnimationFrame(animationFrame);
    windowRef.removeEventListener("resize", resize);
  };
}
