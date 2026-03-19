// C:\MGPT\大港素材整理\2-5女神龍_Media Lounge_檔案存放區\ML6\ML6.mp4
const mediaLounge = [
	{
		'pre': '1-5南霸天',
		'max': 10
	},
	{
		'pre': '2-5女神龍',
		'max': 12
	}
]

const result = mediaLounge.flatMap(item => {
	const paths = [];
	for (let i = 1; i <= item.max; i++) {
		paths.push(`C:\\MGPT\\大港素材整理\\${item.pre}_Media Lounge_檔案存放區\\ML${i}\\ML${i}.mp4`);
	}
	return paths;
});

console.log(result);