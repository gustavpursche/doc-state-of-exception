const autoprefixer = require('gulp-autoprefixer');
const awspublish = require('gulp-awspublish');
const cloudfront = require('gulp-cloudfront-invalidate');
const concat = require('gulp-concat');
const cssnano = require('gulp-cssnano');
const fs = require('fs');
const gulp = require('gulp');
const gulpIf = require('gulp-if');
const gulpWebpack = require('webpack-stream');
const header = require('gulp-header');
const htmlmin = require('gulp-htmlmin');
const imagemin = require('gulp-imagemin');
const merge = require('merge-stream');
const os = require('os');
const parallelize = require('concurrent-transform');
const path = require('path');
const process = require('process');
const rename = require('gulp-rename');
const replace = require('gulp-replace');
const resize = require('gulp-image-resize')
const sass = require('gulp-sass');
const sourcemaps = require('gulp-sourcemaps');
const webpack = require('webpack');

const ENV = process.env.ENV || 'dev';
const s3Config = require('./aws.json').s3;
const cloudfrontConfig = {
  accessKeyId: s3Config.accessKeyId,
  secretAccessKey: s3Config.secretAccessKey,
  region: s3Config.region,
  bucket: s3Config.bucket,
  distribution: require('./aws.json').cloudfront.distributionId,
  paths: [
    '/state-of-exception/dist/*',
  ],
};
const IMAGE_SIZES = [ 400, 600, 800, 1200, 1400, 1800, 2000 ];

let ASSET_PATH = '/dist/assets';

if (ENV === 'production') {
  ASSET_PATH = 'https://cdn.jib-collective.net/state-of-exception/dist/assets';
}

gulp.task('markup', () => {
  return gulp.src('markup/**/*.html')
    .pipe(replace(/{{([a-z]+) ([a-z]+=".*")}}/gi, (...args) => {
      const [match, type, rawAttrs, position] = args;
      const attrs = rawAttrs.split(' ').reduce((acc, attr) => {
        const [key, value] = attr.split('=');
        acc[key] = value.replace(/\"/gi, '');
        return acc;
      }, {});

      switch(type) {
        case 'asset':
          const package = require('./package.json');
          const cacheBust = `?version=${package.version}`;

          switch(attrs.type) {
            case 'style':
              return `${ASSET_PATH}/styles/app.css${cacheBust}`;
              break;

            case 'script':
              return `${ASSET_PATH}/scripts/app.js${cacheBust}`;
              break;
          }
          break;

        case 'image':
          const name = `G20_${attrs.name}`;
          const captionFileName = `${name}-${attrs.language}.txt`;
          const captionPath = path.resolve(`./assets/images/${captionFileName}`);
          const caption = fs.readFileSync(captionPath, 'utf-8');
          const getSourceSet = fileName => {
            const sortedSizes = Array.from(IMAGE_SIZES).reverse();

            return sortedSizes.map(width => `
              ${ASSET_PATH}/images/${name}-${width}.jpg ${width}w
            `).join(', ');
          };

          return `
            <figure class="image">
              <img data-src="${ASSET_PATH}/images/${name}-2000.jpg"
                   data-srcset="${getSourceSet(name)}"
                   alt=""
                   class="js-lazy-image" />

              <figcaption class="image__caption">
                <p>${caption}</p>
              </figcaption>
            </figure>
          `;
          break;
      }

      return '';
    }))
    .pipe(gulpIf(ENV === 'production', htmlmin()))
    .pipe(gulp.dest('dist/markup/'));
});

gulp.task('images', () => {
  const imageStream = merge();
  const defaults = {
    crop : false,
    imageMagick: true,
    upscale : false,
  };

  IMAGE_SIZES.forEach(width => {
    const options = Object.assign({}, defaults, { width });
    const stream = gulp.src('assets/images/**/*')
        .pipe(parallelize(
          resize(options),
          os.cpus().length
        ))
        .pipe(parallelize(
          imagemin([
            imagemin.jpegtran({
              progressive: true,
            }),
          ], {
            verbose: false,
          }),
          os.cpus().length
        ))
        .pipe(rename(path => {
          path.basename += `-${width}`;
        }));

    imageStream.add(stream);
  });

  return imageStream
    .pipe(gulp.dest('dist/assets/images'));
});

gulp.task('scripts', () => {
  return gulp.src('assets/scripts/app.js')
    .pipe(gulpWebpack(require(`./webpack-config.${ENV}`), webpack))
    .pipe(gulp.dest('dist/assets/scripts/'));
});

gulp.task('fonts', () => {
  return gulp.src('assets/fonts/**/*')
    .pipe(gulp.dest('dist/assets/fonts/'));
});

gulp.task('styles', () => {
  return gulp.src('assets/styles/app.scss')
      .pipe(header(`
          $font-path: "${ASSET_PATH}/fonts/";
      `))
      .pipe(sass().on('error', sass.logError))
      .pipe(gulpIf(ENV !== 'production', sourcemaps.init()))
      .pipe(concat('app.css'))
      .pipe(autoprefixer({
          browsers: [
            'last 2 versions',
          ],
      }))
      .pipe(gulpIf(ENV === 'production', cssnano()))
      .pipe(gulpIf(ENV !== 'production', sourcemaps.write()))
      .pipe(gulp.dest('dist/assets/styles/'));
});

gulp.task('upload', ['styles', 'scripts', 'images', 'markup'], () => {
  let publisher = awspublish.create(s3Config);
  const cacheTime = (60 * 60 * 24) * 14; // 14 days
  const awsHeaders = {
    'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}`,
  };
  const gzippable = function(file) {
    const match = file.path.match(/\.(html|css|js|ttf|otf)$/gi);
    return match;
  };

  return gulp.src([
    './dist/**/*',
  ])
    .pipe(rename((path) => {
        path.dirname = `/state-of-exception/dist/${path.dirname}`;
        return path;
    }))
    .pipe(gulpIf(gzippable, awspublish.gzip()))
    .pipe(publisher.cache())
    .pipe(parallelize(publisher.publish(awsHeaders), 10))
    .pipe(awspublish.reporter())
    .pipe(cloudfront(cloudfrontConfig));
});

gulp.task('watch', ['build',], () => {
  gulp.watch('assets/styles/**/*', ['styles']);
  gulp.watch('assets/scripts/**/*', ['scripts']);
  gulp.watch('assets/images/**/*', ['images']);
  gulp.watch('markup/**/*.html', ['markup']);
});

gulp.task('build', [
  'fonts',
  'markup',
  //'images',
  'styles',
  'scripts',
]);
